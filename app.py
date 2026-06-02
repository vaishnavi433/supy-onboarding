import os
import json
import requests
import logging
from flask import Flask, request, jsonify
from flask_cors import CORS
from datetime import datetime, timezone

app = Flask(__name__)
CORS(app, resources={r"/*": {"origins": "*"}}, supports_credentials=True)

# ── CONFIGURATION (Values are pulled from the WSGI Vault) ────────
CLIENT_ID           = os.environ.get("CLIENT_ID", "")
CLIENT_SECRET       = os.environ.get("CLIENT_SECRET", "")
REFRESH_TOKEN       = os.environ.get("REFRESH_TOKEN", "")

# 🔴 HUBSPOT ACCOUNT ID 🔴
HUBSPOT_PORTAL_ID   = "9423176"

GMAIL_CLIENT_ID     = os.environ.get("GMAIL_CLIENT_ID", "")
GMAIL_CLIENT_SECRET = os.environ.get("GMAIL_CLIENT_SECRET", "")
GMAIL_REFRESH_TOKEN = os.environ.get("GMAIL_REFRESH_TOKEN", "")

SLACK_WEBHOOK_URL   = os.environ.get("SLACK_WEBHOOK_URL", "")
GOOGLE_SCRIPT_URL   = os.environ.get("GOOGLE_SCRIPT_URL", "")


EMAIL_FROM       = "vaishnavi@supy.io"
EMAIL_RECIPIENTS = ["vaishnavi@supy.io", "randhir@supy.io", "kenneth@supy.io"]

LOG_FILE = os.path.join(os.path.dirname(__file__), "submissions.log")
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

def log_submission(email, company, submitted_at, status):
    try:
        with open(LOG_FILE, "a") as f:
            f.write(f"{submitted_at} | {email} | {company} | {status}\n")
    except Exception as e:
        logger.error(f"Log write error: {e}")

# ── 1. HUBSPOT (The Ultimate Smart Linker) ───────────────────────
def get_hubspot_token():
    r = requests.post("https://api.hubapi.com/oauth/v1/token", data={
        "grant_type": "refresh_token", "client_id": CLIENT_ID,
        "client_secret": CLIENT_SECRET, "refresh_token": REFRESH_TOKEN,
    })
    return r.json().get("access_token") if r.status_code == 200 else None

def upsert_contact(token, d):
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
    email = d.get("champion_email")
    props = {"email": email, "firstname": d.get("champion_name"), "jobtitle": d.get("champion_title"), "phone": d.get("champion_phone")}
    search = requests.post("https://api.hubapi.com/crm/v3/objects/contacts/search", headers=headers,
                           json={"filterGroups": [{"filters": [{"propertyName": "email", "operator": "EQ", "value": email}]}]})
    results = search.json().get("results", [])
    if results:
        cid = results[0]["id"]
        requests.patch(f"https://api.hubapi.com/crm/v3/objects/contacts/{cid}", headers=headers, json={"properties": props})
        return cid
    else:
        create = requests.post("https://api.hubapi.com/crm/v3/objects/contacts", headers=headers, json={"properties": props})
        return create.json().get("id")

def link_everything(token, note_id, contact_id, company_name):
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
    
    # 1. Link the Note to the Contact
    requests.post("https://api.hubapi.com/crm/v3/associations/Notes/Contacts/batch/create", headers=headers, json={"inputs": [{"from": {"id": note_id}, "to": {"id": contact_id}, "type": "note_to_contact"}]})
    
    # 2. SMART CHECK: If Contact is already linked to a Deal, put the note on that Deal!
    try:
        r = requests.get(f"https://api.hubapi.com/crm/v3/objects/contacts/{contact_id}/associations/deals", headers=headers)
        if r.status_code == 200:
            for d in r.json().get("results", []):
                requests.post("https://api.hubapi.com/crm/v3/associations/Notes/Deals/batch/create", headers=headers, json={"inputs": [{"from": {"id": note_id}, "to": {"id": d["id"]}, "type": "note_to_deal"}]})
    except Exception as e: logger.warning(f"link_everything: {e}")

    if not company_name or company_name.lower() == "unknown": return

    # 3. Search Deal by Name (Just in case)
    try:
        deals = requests.post("https://api.hubapi.com/crm/v3/objects/deals/search", headers=headers, 
                              json={"filterGroups": [{"filters": [{"propertyName": "dealname", "operator": "CONTAINS_TOKEN", "value": company_name}]}]}).json().get("results", [])
        for deal in deals:
            requests.post("https://api.hubapi.com/crm/v3/associations/Notes/Deals/batch/create", headers=headers, json={"inputs": [{"from": {"id": note_id}, "to": {"id": deal["id"]}, "type": "note_to_deal"}]})
            requests.post("https://api.hubapi.com/crm/v3/associations/Contacts/Deals/batch/create", headers=headers, json={"inputs": [{"from": {"id": contact_id}, "to": {"id": deal["id"]}, "type": "contact_to_deal"}]})
    except Exception as e: logger.warning(f"link_everything: {e}")

    # 4. Search Company by Name -> Link everything to it, including its Deals
    try:
        comps = requests.post("https://api.hubapi.com/crm/v3/objects/companies/search", headers=headers, 
                              json={"filterGroups": [{"filters": [{"propertyName": "name", "operator": "CONTAINS_TOKEN", "value": company_name}]}]}).json().get("results", [])
        if comps:
            comp_id = comps[0]["id"]
            requests.post("https://api.hubapi.com/crm/v3/associations/Contacts/Companies/batch/create", headers=headers, json={"inputs": [{"from": {"id": contact_id}, "to": {"id": comp_id}, "type": "contact_to_company"}]})
            requests.post("https://api.hubapi.com/crm/v3/associations/Notes/Companies/batch/create", headers=headers, json={"inputs": [{"from": {"id": note_id}, "to": {"id": comp_id}, "type": "note_to_company"}]})
            
            # Put note on any Deals this Company owns
            r_comp = requests.get(f"https://api.hubapi.com/crm/v3/objects/companies/{comp_id}/associations/deals", headers=headers)
            if r_comp.status_code == 200:
                for d in r_comp.json().get("results", []):
                    requests.post("https://api.hubapi.com/crm/v3/associations/Notes/Deals/batch/create", headers=headers, json={"inputs": [{"from": {"id": note_id}, "to": {"id": d["id"]}, "type": "note_to_deal"}]})
    except Exception as e: logger.warning(f"link_everything: {e}")

def build_note(d, branches, submitted_at):
    it_same = (d.get("it_same_as_champion") or "").lower()
    
    # 🟢 UPDATED: Extracts POS and Accounting safely and formats them outside the IT Name block
    it_contact = f"<b>Same as Internal Champion</b> — {d.get('champion_name','')}" if it_same == "yes" else f"Name: {d.get('it_name','')}<br>Email: {d.get('it_email','')}"
    it_block = f"{it_contact}<br><br><b>POS System:</b> {d.get('pos_system','')}<br><b>Accounting SW:</b> {d.get('accounting_software','')}"
    
    branch_rows = ""
    for i, b in enumerate(branches, 1):
        hours = f"{b.get('open','')} – {b.get('close','')}".strip(" –")
        branch_rows += f"<tr><td style='padding:5px 8px;border-bottom:1px solid #eee'>{i}</td><td style='padding:5px 8px;border-bottom:1px solid #eee'><b>{b.get('name','')}</b></td><td style='padding:5px 8px;border-bottom:1px solid #eee'>{b.get('address','')}</td><td style='padding:5px 8px;border-bottom:1px solid #eee'>{b.get('cost_center','')}</td><td style='padding:5px 8px;border-bottom:1px solid #eee'>{hours}</td></tr>"
    branch_section = f"<table style='border-collapse:collapse;width:100%;font-size:12px'><tr style='background:#321e57;color:#fff'><th style='padding:6px 8px'>#</th><th style='padding:6px 8px'>Branch Name</th><th style='padding:6px 8px'>Address</th><th style='padding:6px 8px'>Cost Center</th><th style='padding:6px 8px'>Hours</th></tr>{branch_rows}</table>" if branch_rows else "<i>No branch data provided.</i>"

    def link_cell(label, link): return f"{label}: <a href='{link.strip()}' target='_blank'>{link.strip()}</a>" if link and link.strip() else f"{label}: —"
    files_block = link_cell("Invoices", d.get("invoices_link","")) + "<br>" + link_cell("Supplier Details", d.get("suppliers_link",""))

    return (
        f"<h3 style='color:#321e57;margin:0 0 4px'>SUPY ONBOARDING</h3><p style='color:#888;font-size:11px;margin:0 0 16px'>Submitted: {submitted_at}</p>"
        f"<h4 style='color:#503390;border-bottom:1px solid #e0d8f0;padding-bottom:4px;margin:14px 0 8px'>COMPANY INFO</h4>Company Name: {d.get('company_name','')}"
        f"<h4 style='color:#503390;border-bottom:1px solid #e0d8f0;padding-bottom:4px;margin:14px 0 8px'>INTERNAL CHAMPION</h4>Name: {d.get('champion_name','')}<br>Title: {d.get('champion_title','')}<br>Email: {d.get('champion_email','')}<br>Phone: {d.get('champion_phone','')}"
        f"<h4 style='color:#503390;border-bottom:1px solid #e0d8f0;padding-bottom:4px;margin:14px 0 8px'>FINANCE POC</h4>External Accounting Firm: {d.get('accounting_external','')}<br>Name: {d.get('finance_name','')}<br>Title: {d.get('finance_title','')}<br>Email: {d.get('finance_email','')}<br>Phone: {d.get('finance_phone','')}"
        f"<h4 style='color:#503390;border-bottom:1px solid #e0d8f0;padding-bottom:4px;margin:14px 0 8px'>IT & SYSTEMS</h4>{it_block}"
        f"<h4 style='color:#503390;border-bottom:1px solid #e0d8f0;padding-bottom:4px;margin:14px 0 8px'>BRANCH CONFIGURATION</h4>{branch_section}"
        f"<h4 style='color:#503390;border-bottom:1px solid #e0d8f0;padding-bottom:4px;margin:14px 0 8px'>OPERATIONS</h4>Order Method: {d.get('ordering_method','')}<br>PO Approver: {d.get('po_approver','')}<br>Ordering Structure: {d.get('ordering_structure','')}<br>Stock Counts: {d.get('stock_counts','')}<br>Stock Count Duration: {d.get('stock_count_duration','')}<br>Inventory System: {d.get('inventory_system','')}"
        f"<h4 style='color:#503390;border-bottom:1px solid #e0d8f0;padding-bottom:4px;margin:14px 0 8px'>FOOD COST</h4>Current Food Cost %: {d.get('food_cost_current','')}<br>Target Food Cost %: {d.get('food_cost_target','')}<br>COGS Method: {d.get('cogs_method','')}<br>Invoice Delivery: {d.get('invoice_delivery','')}<br>Finance Complications: {d.get('finance_complications','')}"
        f"<h4 style='color:#503390;border-bottom:1px solid #e0d8f0;padding-bottom:4px;margin:14px 0 8px'>GOALS &amp; BLOCKERS</h4>Top Problem to Solve: {d.get('top_problem','')}<br>CSM Notes: {d.get('extra_notes','')}<br>Known Blockers: {d.get('blockers','')}<br>Target Go-Live: {d.get('golive_date','')}"
        f"<h4 style='color:#503390;border-bottom:1px solid #e0d8f0;padding-bottom:4px;margin:14px 0 8px'>FILE LINKS</h4>{files_block}"
    )

# ── 2. SLACK (Upgraded with a green Button) ──────────────────────
def send_slack_notification(d, branches, submitted_at, cid):
    if not SLACK_WEBHOOK_URL: return False
    
    hs_link = f"https://app.hubspot.com/contacts/{HUBSPOT_PORTAL_ID}/record/0-1/{cid}" if cid else "https://app.hubspot.com/contacts/"
    
    blocks = [
        {"type": "header", "text": {"type": "plain_text", "text": "🎉 New Onboarding Submission", "emoji": True}},
        {
            "type": "section",
            "fields": [
                {"type": "mrkdwn", "text": f"*Company:*\n{d.get('company_name', 'Unknown')}"},
                {"type": "mrkdwn", "text": f"*Champion:*\n{d.get('champion_name', '-')} ({d.get('champion_email', '-')})"},
                {"type": "mrkdwn", "text": f"*Branches:*\n{len(branches)} location(s)"},
                {"type": "mrkdwn", "text": f"*Target Go-Live:*\n{d.get('golive_date', 'Not specified')}"},
                {"type": "mrkdwn", "text": f"*POS System:*\n{d.get('pos_system', '-')}"},
                {"type": "mrkdwn", "text": f"*Accounting:*\n{d.get('accounting_software', '-')}"}
            ]
        },
        {
            "type": "actions",
            "elements": [
                {
                    "type": "button",
                    "text": {
                        "type": "plain_text",
                        "text": "View in HubSpot",
                        "emoji": True
                    },
                    "style": "primary",
                    "url": hs_link
                }
            ]
        }
    ]
    r = requests.post(SLACK_WEBHOOK_URL, json={"blocks": blocks})
    return True if r.status_code == 200 else False

# ── 3. GMAIL ─────────────────────────────────────────────────────
def get_gmail_access_token():
    r = requests.post("https://oauth2.googleapis.com/token", data={"grant_type": "refresh_token", "client_id": GMAIL_CLIENT_ID, "client_secret": GMAIL_CLIENT_SECRET, "refresh_token": GMAIL_REFRESH_TOKEN})
    return r.json().get("access_token") if r.status_code == 200 else None

def send_email_notification(d, branches, submitted_at, cid):
    token = get_gmail_access_token()
    if not token: return False
    import base64
    from email.mime.multipart import MIMEMultipart
    from email.mime.text import MIMEText
    hs_link = f"https://app.hubspot.com/contacts/{HUBSPOT_PORTAL_ID}/record/0-1/{cid}" if cid else "https://app.hubspot.com/contacts/"
    company = d.get("company_name", "Unknown Company")
    msg = MIMEMultipart("alternative")
    msg["Subject"] = f"🚀 New Onboarding: {company}"
    msg["From"], msg["To"] = EMAIL_FROM, ", ".join(EMAIL_RECIPIENTS)
    note_body = build_note(d, branches, submitted_at)
    html_body = (
        f"<div style='font-family:Arial,sans-serif;max-width:700px;margin:auto;padding:24px;border:1px solid #e0d8f0;border-radius:8px'>"
        f"{note_body}"
        f"<br><a href='{hs_link}' style='display:inline-block;padding:10px 15px;background-color:#321e57;color:white;text-decoration:none;border-radius:5px;'>Open Contact in HubSpot</a>"
        f"</div>"
    )
    msg.attach(MIMEText(html_body, "html"))
    raw = base64.urlsafe_b64encode(msg.as_bytes()).decode()
    r = requests.post("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"}, json={"raw": raw})
    return True if r.status_code == 200 else False

# ── 4. GOOGLE SHEETS ─────────────────────────────────────────────
def log_to_sheets(d, branches, submitted_at):
    if not GOOGLE_SCRIPT_URL: return False
    payload = d.copy()
    payload["submitted_at"] = submitted_at
    payload["branch_count"] = len(branches)
    try:
        r = requests.post(GOOGLE_SCRIPT_URL, json=payload, timeout=10)
        return r.status_code < 300
    except Exception as e:
        logger.warning(f"log_to_sheets: {e}")
        return False

# ── THE MAIN WEBHOOK ─────────────────────────────────────────────
@app.route("/webhook", methods=["POST", "OPTIONS"])
def webhook():
    if request.method == "OPTIONS":
        return jsonify({"status": "ok"}), 200, {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type"
        }
    
    try:
        d = request.values.to_dict()

        # 🟢 SERVER-SIDE BOUNCER: Strictly reject if POS or Accounting is missing
        if not d.get("pos_system") or not d.get("accounting_software"):
            return jsonify({"status": "error", "message": "POS System and Accounting Software are strictly required."}), 400

        email = d.get("champion_email", "Unknown").strip()
        company = d.get("company_name", "Unknown").strip()
        submitted_at = datetime.now(timezone.utc).strftime("%d %b %Y %H:%M UTC")

        branches = []
        if d.get("branches_json"):
            try: branches = json.loads(d["branches_json"])
            except: pass

        results = []

        # 1. HubSpot FIRST (Creates Contact, Note, and Links Everything)
        token = get_hubspot_token()
        cid = None
        if token:
            cid = upsert_contact(token, d)
            if cid:
                note_body = build_note(d, branches, submitted_at)
                note_r = requests.post("https://api.hubapi.com/crm/v3/objects/notes", headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"}, json={"properties": {"hs_note_body": note_body, "hs_timestamp": datetime.now(timezone.utc).isoformat()}})
                if note_r.status_code == 201:
                    nid = note_r.json().get("id")
                    link_everything(token, nid, cid, company)
                    results.append("hubspot:ok")
                else:
                    results.append("hubspot:note-fail")
            else:
                results.append("hubspot:contact-fail")

        # 2. Slack
        if send_slack_notification(d, branches, submitted_at, cid): results.append("slack:ok")
        else: results.append("slack:fail")

        # 3. Gmail
        if send_email_notification(d, branches, submitted_at, cid): results.append("email:ok")
        else: results.append("email:fail")

        # 4. Sheets
        if log_to_sheets(d, branches, submitted_at): results.append("sheets:ok")
        else: results.append("sheets:fail")

        log_submission(email, company, submitted_at, "|".join(results))
        return jsonify({"status": "ok", "details": results}), 200
    except Exception as e:
        import traceback
        logger.error(f"webhook error: {traceback.format_exc()}")
        return jsonify({"status": "error", "message": str(e)}), 500

@app.route("/debug", methods=["GET"])
def debug():
    return jsonify({
        "CLIENT_ID": bool(CLIENT_ID),
        "CLIENT_SECRET": bool(CLIENT_SECRET),
        "REFRESH_TOKEN": bool(REFRESH_TOKEN),
        "GMAIL_CLIENT_ID": bool(GMAIL_CLIENT_ID),
        "GMAIL_CLIENT_SECRET": bool(GMAIL_CLIENT_SECRET),
        "GMAIL_REFRESH_TOKEN": bool(GMAIL_REFRESH_TOKEN),
        "SLACK_WEBHOOK_URL": bool(SLACK_WEBHOOK_URL),
        "GOOGLE_SCRIPT_URL": bool(GOOGLE_SCRIPT_URL),
    })

@app.route("/logs", methods=["GET"])
def view_logs():
    try:
        with open(LOG_FILE, "r") as f: return f"<pre>{f.read()}</pre>"
    except: return "No logs found.", 200

@app.route("/")
def index(): return "Supy Automation Server: Online", 200

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 5000)))

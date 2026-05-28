/**
 * Supy Onboarding — Cloudflare Worker
 *
 * Drop-in replacement for the PythonAnywhere Flask server.
 * Env vars (set as Worker Secrets via wrangler or the dashboard):
 *   CLIENT_ID, CLIENT_SECRET, REFRESH_TOKEN          — HubSpot OAuth
 *   GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET,
 *   GMAIL_REFRESH_TOKEN                              — Gmail OAuth
 *   SLACK_WEBHOOK_URL                                — Slack incoming webhook
 *   GOOGLE_SCRIPT_URL                                — Google Apps Script URL
 *
 * KV binding (optional — for /logs endpoint):
 *   LOGS  →  bound in wrangler.toml as [[kv_namespaces]]
 *
 * File uploads:
 *   Files are uploaded to HubSpot File Manager (Files v3 API).
 *   No extra secrets needed — uses the same HubSpot OAuth credentials.
 *   Files are stored under supy-onboarding/{date}_{company}/ and are publicly accessible.
 *
 * Routes:
 *   POST /webhook      — main form handler
 *   POST /upload       — receive a file, store to Supabase, return public URL
 *   GET  /logs         — recent submission log
 *   GET  /             — health check
 */

const HUBSPOT_PORTAL_ID = "9423176";
const EMAIL_FROM        = "vaishnavi@supy.io";
const EMAIL_RECIPIENTS  = ["vaishnavi@supy.io", "randhir@supy.io", "kenneth@supy.io"];

// ─────────────────────────────────────────────────────────────
// CORS helpers
// ─────────────────────────────────────────────────────────────
const CORS_HEADERS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function withCors(response) {
  const r = new Response(response.body, response);
  for (const [k, v] of Object.entries(CORS_HEADERS)) r.headers.set(k, v);
  return r;
}

function json(data, status = 200) {
  return withCors(new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  }));
}

// ─────────────────────────────────────────────────────────────
// Main entry
// ─────────────────────────────────────────────────────────────
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (url.pathname === "/webhook" && request.method === "POST") {
      return handleWebhook(request, env);
    }

    if (url.pathname === "/upload" && request.method === "POST") {
      return handleUpload(request, env);
    }

    if (url.pathname === "/download" && request.method === "GET") {
      return handleDownload(request, env);
    }

    if (url.pathname === "/logs" && request.method === "GET") {
      return handleLogs(env);
    }

    if (url.pathname === "/debug" && request.method === "GET") {
      // Test Cloudinary connectivity
      let cloudinaryReachable = false;
      let cloudinaryError = null;
      if (env.CLOUDINARY_CLOUD_NAME && env.CLOUDINARY_API_KEY) {
        try {
          const r = await fetch(`https://api.cloudinary.com/v1_1/${env.CLOUDINARY_CLOUD_NAME}/resources/image?max_results=1`, {
            headers: { Authorization: "Basic " + btoa(`${env.CLOUDINARY_API_KEY}:${env.CLOUDINARY_API_SECRET}`) },
          });
          cloudinaryReachable = r.ok;
          if (!cloudinaryReachable) cloudinaryError = `HTTP ${r.status}`;
        } catch (e) {
          cloudinaryError = e.message;
        }
      }
      return json({
        CLIENT_ID:            Boolean(env.CLIENT_ID),
        CLIENT_SECRET:        Boolean(env.CLIENT_SECRET),
        REFRESH_TOKEN:        Boolean(env.REFRESH_TOKEN),
        GMAIL_CLIENT_ID:      Boolean(env.GMAIL_CLIENT_ID),
        GMAIL_CLIENT_SECRET:  Boolean(env.GMAIL_CLIENT_SECRET),
        GMAIL_REFRESH_TOKEN:  Boolean(env.GMAIL_REFRESH_TOKEN),
        SLACK_WEBHOOK_URL:    Boolean(env.SLACK_WEBHOOK_URL),
        GOOGLE_SCRIPT_URL:    Boolean(env.GOOGLE_SCRIPT_URL),
        CLOUDINARY_CLOUD_NAME: Boolean(env.CLOUDINARY_CLOUD_NAME),
        CLOUDINARY_API_KEY:    Boolean(env.CLOUDINARY_API_KEY),
        CLOUDINARY_API_SECRET: Boolean(env.CLOUDINARY_API_SECRET),
        SLACK_TEST_WEBHOOK:   Boolean(env.SLACK_TEST_WEBHOOK_URL),
        cloudinary_reachable: cloudinaryReachable,
        cloudinary_error:     cloudinaryError,
      });
    }

    if (url.pathname === "/") {
      return withCors(new Response("Supy Automation Server: Online", { status: 200 }));
    }

    return withCors(new Response("Not Found", { status: 404 }));
  },
};

// ─────────────────────────────────────────────────────────────
// Webhook handler
// ─────────────────────────────────────────────────────────────
async function handleWebhook(request, env) {
  let d = {};
  const contentType = request.headers.get("content-type") || "";

  if (contentType.includes("application/json")) {
    d = await request.json();
  } else {
    const form = await request.formData();
    for (const [k, v] of form.entries()) d[k] = v;
  }

  // Strictly require POS + Accounting
  if (!d.pos_system || !d.accounting_software) {
    return json({ status: "error", message: "POS System and Accounting Software are strictly required." }, 400);
  }

  const email       = (d.champion_email || "Unknown").trim();
  const company     = (d.company_name   || "Unknown").trim();
  const submittedAt = new Date().toUTCString().replace(/GMT/, "UTC").replace(/:\d\d /, " ");

  let branches = [];
  if (d.branches_json) {
    try { branches = JSON.parse(d.branches_json); } catch {}
  }

  const results = [];

  // 1. HubSpot
  const token = await getHubspotToken(env);
  let cid = null;
  if (token) {
    const { id: contactId, action } = await upsertContact(token, d);
    cid = contactId;
    if (cid) {
      const noteBody = buildNote(d, branches, submittedAt);
      const noteRes = await fetch("https://api.hubapi.com/crm/v3/objects/notes", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ properties: { hs_note_body: noteBody, hs_timestamp: new Date().toISOString() } }),
      });
      if (noteRes.status === 201) {
        const noteJson = await noteRes.json();
        await linkEverything(token, noteJson.id, cid, company);
        results.push(`hubspot:${action}:note-ok`);
      } else {
        const noteErr = await noteRes.text();
        console.error("HubSpot note create failed", noteRes.status, noteErr);
        results.push(`hubspot:${action}:note-fail`);
      }
    } else {
      results.push("hubspot:contact-fail");
    }
  } else {
    results.push("hubspot:auth-fail");
  }

  // 2. Slack (main channel)
  const slackOk = await sendSlack(env, d, branches, submittedAt, cid);
  results.push(slackOk ? "slack:ok" : "slack:fail");

  // 2b. Slack test channel — fires only when champion_email is vaishnavi@supy.io
  if ((d.champion_email || "").toLowerCase().trim() === "vaishnavi@supy.io") {
    const testOk = await sendSlackTestChannel(env, d, branches, submittedAt, cid);
    results.push(testOk ? "slack-test:ok" : "slack-test:fail");
  }

  // 3. Gmail
  const emailOk = await sendEmail(env, d, branches, submittedAt, cid);
  results.push(emailOk ? "email:ok" : "email:fail");

  // 4. Google Sheets
  const sheetsOk = await logToSheets(env, d, branches, submittedAt);
  results.push(sheetsOk ? "sheets:ok" : "sheets:fail");

  // 5. KV log (best-effort)
  await appendLog(env, email, company, submittedAt, results.join("|"));

  return json({ status: "ok", details: results });
}

// ─────────────────────────────────────────────────────────────
// Logs endpoint
// ─────────────────────────────────────────────────────────────
async function handleLogs(env) {
  if (!env.LOGS) {
    return withCors(new Response("KV binding LOGS not configured.", { status: 200 }));
  }
  const log = (await env.LOGS.get("submissions")) || "No logs yet.";
  return withCors(new Response(`<pre>${log}</pre>`, {
    status: 200,
    headers: { "Content-Type": "text/html" },
  }));
}

// ─────────────────────────────────────────────────────────────
// File upload  (POST /upload)
// Accepts multipart/form-data: file + company.
// Stores to Cloudinary and returns the secure public URL.
// Requires: CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET secrets.
// ─────────────────────────────────────────────────────────────
async function handleUpload(request, env) {
  if (!env.CLOUDINARY_CLOUD_NAME || !env.CLOUDINARY_API_KEY || !env.CLOUDINARY_API_SECRET) {
    return json({ error: "Cloudinary not configured — set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET secrets" }, 500);
  }

  let form;
  try {
    form = await request.formData();
  } catch {
    return json({ error: "Invalid multipart body" }, 400);
  }

  const file    = form.get("file");
  const company = (form.get("company") || "unknown").trim();

  if (!file || typeof file === "string") {
    return json({ error: "No file provided" }, 400);
  }
  if (file.size > 50 * 1024 * 1024) {
    return json({ error: "File too large (max 50 MB)" }, 413);
  }

  const slug      = company.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "unknown";
  const date      = new Date().toISOString().slice(0, 10);
  const uid       = crypto.randomUUID().slice(0, 8);
  const safeName  = file.name.replace(/\.[^.]+$/, "").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80);
  // Full path as public_id (no separate folder param — avoids double-nesting)
  const publicId  = `supy-onboarding/${date}_${slug}/${uid}_${safeName}`;
  const timestamp = Math.floor(Date.now() / 1000).toString();

  // Cloudinary signed upload: signature = SHA1(sorted_params + api_secret)
  // Params sent: public_id, timestamp (alphabetical order)
  const sigInput  = `public_id=${publicId}&timestamp=${timestamp}${env.CLOUDINARY_API_SECRET}`;
  const sigBuffer = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(sigInput));
  const signature = Array.from(new Uint8Array(sigBuffer)).map(b => b.toString(16).padStart(2, "0")).join("");

  const clForm = new FormData();
  clForm.append("file",      new Blob([await file.arrayBuffer()], { type: file.type || "application/octet-stream" }), file.name);
  clForm.append("api_key",   env.CLOUDINARY_API_KEY);
  clForm.append("timestamp", timestamp);
  clForm.append("signature", signature);
  clForm.append("public_id", publicId);

  const uploadRes  = await fetch(
    `https://api.cloudinary.com/v1_1/${env.CLOUDINARY_CLOUD_NAME}/auto/upload`,
    { method: "POST", body: clForm }
  );
  const uploadJson = await uploadRes.json();

  if (!uploadRes.ok) {
    console.error("Cloudinary upload failed", uploadRes.status, JSON.stringify(uploadJson));
    return json({ error: `File upload failed: ${uploadJson.error?.message || uploadRes.status}` }, 500);
  }

  return json({
    url:  `https://supy-onboarding.vaishnavi-5d1.workers.dev/download?key=${encodeURIComponent(uploadJson.public_id)}&name=${encodeURIComponent(file.name)}`,
    key:  uploadJson.public_id,
    name: file.name,
    size: file.size,
  });
}

// ─────────────────────────────────────────────────────────────
// File download proxy  (GET /download?key=<public_id>&name=<filename>)
// Cloudinary raw files require signed delivery. This endpoint
// generates a signed archive URL on the fly using the API credentials
// and streams the file to the browser — so every stored URL keeps
// working permanently regardless of Cloudinary delivery restrictions.
// ─────────────────────────────────────────────────────────────
async function handleDownload(request, env) {
  if (!env.CLOUDINARY_CLOUD_NAME || !env.CLOUDINARY_API_KEY || !env.CLOUDINARY_API_SECRET) {
    return json({ error: "Cloudinary not configured" }, 500);
  }

  const params    = new URL(request.url).searchParams;
  const publicId  = params.get("key");
  const filename  = params.get("name") || publicId?.split("/").pop() || "download";

  if (!publicId) return json({ error: "Missing ?key= parameter" }, 400);

  // Build a signed generate_archive URL.
  // Cloudinary signs arrays as comma-joined values: public_ids=a,b,c
  // Params sorted alphabetically: mode < public_ids < timestamp
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const toSign    = `mode=download&public_ids=${publicId.replace(/&/g, "%26")}&timestamp=${timestamp}${env.CLOUDINARY_API_SECRET}`;
  const sigBuf    = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(toSign));
  const signature = Array.from(new Uint8Array(sigBuf)).map(b => b.toString(16).padStart(2, "0")).join("");

  const archiveUrl = `https://api.cloudinary.com/v1_1/${env.CLOUDINARY_CLOUD_NAME}/raw/generate_archive`
    + `?mode=download`
    + `&public_ids%5B%5D=${encodeURIComponent(publicId)}`
    + `&timestamp=${timestamp}`
    + `&api_key=${env.CLOUDINARY_API_KEY}`
    + `&signature=${signature}`;

  const upstream = await fetch(archiveUrl);
  if (!upstream.ok) {
    const err = await upstream.text();
    console.error("Cloudinary download failed", upstream.status, err);
    return json({ error: `Download failed: ${upstream.status}` }, 502);
  }

  // Stream straight to the browser with the correct filename
  return new Response(upstream.body, {
    status: 200,
    headers: {
      ...CORS_HEADERS,
      "Content-Type":        upstream.headers.get("Content-Type") || "application/octet-stream",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control":       "no-store",
    },
  });
}

async function appendLog(env, email, company, submittedAt, status) {
  if (!env.LOGS) return;
  try {
    const existing = (await env.LOGS.get("submissions")) || "";
    const line = `${submittedAt} | ${email} | ${company} | ${status}\n`;
    // Keep last ~200 lines to stay within KV value limits
    const lines = (existing + line).split("\n").filter(Boolean);
    const trimmed = lines.slice(-200).join("\n") + "\n";
    await env.LOGS.put("submissions", trimmed);
  } catch {}
}

// ─────────────────────────────────────────────────────────────
// HubSpot
// ─────────────────────────────────────────────────────────────
async function getHubspotToken(env) {
  const r = await fetch("https://api.hubapi.com/oauth/v1/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type:    "refresh_token",
      client_id:     env.CLIENT_ID,
      client_secret: env.CLIENT_SECRET,
      refresh_token: env.REFRESH_TOKEN,
    }),
  });
  if (r.status !== 200) return null;
  return (await r.json()).access_token || null;
}

async function upsertContact(token, d) {
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const email   = d.champion_email;
  const props = {
    email:     email,
    firstname: d.champion_name,
    jobtitle:  d.champion_title,
  };
  // Only include phone if it looks valid (must start with + and country code)
  const rawPhone = (d.champion_phone || "").trim();
  if (rawPhone.startsWith("+")) props.phone = rawPhone;

  // Search for existing contact by email
  const searchRes = await fetch("https://api.hubapi.com/crm/v3/objects/contacts/search", {
    method: "POST", headers,
    body: JSON.stringify({ filterGroups: [{ filters: [{ propertyName: "email", operator: "EQ", value: email }] }] }),
  });
  const searchJson = await searchRes.json();
  const existing   = (searchJson.results || [])[0];

  if (existing) {
    // Contact found — update it
    await fetch(`https://api.hubapi.com/crm/v3/objects/contacts/${existing.id}`, {
      method: "PATCH", headers, body: JSON.stringify({ properties: props }),
    });
    return { id: existing.id, action: "updated" };
  }

  // Contact not found — create a new one
  const createRes  = await fetch("https://api.hubapi.com/crm/v3/objects/contacts", {
    method: "POST", headers, body: JSON.stringify({ properties: props }),
  });
  const createJson = await createRes.json();

  if (createRes.status === 201 && createJson.id) {
    return { id: createJson.id, action: "created" };
  }

  // Edge case: HubSpot returned 409 (duplicate detected on their side) — re-search to get the id
  if (createRes.status === 409) {
    const retryRes  = await fetch("https://api.hubapi.com/crm/v3/objects/contacts/search", {
      method: "POST", headers,
      body: JSON.stringify({ filterGroups: [{ filters: [{ propertyName: "email", operator: "EQ", value: email }] }] }),
    });
    const retryJson = await retryRes.json();
    const found     = (retryJson.results || [])[0];
    if (found) return { id: found.id, action: "updated" };
  }

  // Log the error detail so it surfaces in Cloudflare logs
  console.error("HubSpot contact create failed", createRes.status, JSON.stringify(createJson));
  return { id: null, action: "failed" };
}

async function linkEverything(token, noteId, contactId, companyName) {
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  const assoc = (from, fromId, to, toId, type) =>
    fetch(`https://api.hubapi.com/crm/v3/associations/${from}/${to}/batch/create`, {
      method: "POST", headers,
      body: JSON.stringify({ inputs: [{ from: { id: fromId }, to: { id: toId }, type }] }),
    });

  // Note → Contact
  await assoc("Notes", noteId, "Contacts", contactId, "note_to_contact");

  // Note → any Deals already on the Contact
  try {
    const r = await fetch(`https://api.hubapi.com/crm/v3/objects/contacts/${contactId}/associations/deals`, { headers });
    if (r.status === 200) {
      for (const deal of (await r.json()).results || []) {
        await assoc("Notes", noteId, "Deals", deal.id, "note_to_deal");
      }
    }
  } catch {}

  if (!companyName || companyName.toLowerCase() === "unknown") return;

  // Deals by name
  try {
    const deals = await fetch("https://api.hubapi.com/crm/v3/objects/deals/search", {
      method: "POST", headers,
      body: JSON.stringify({ filterGroups: [{ filters: [{ propertyName: "dealname", operator: "CONTAINS_TOKEN", value: companyName }] }] }),
    });
    for (const deal of (await deals.json()).results || []) {
      await assoc("Notes",    noteId,    "Deals", deal.id, "note_to_deal");
      await assoc("Contacts", contactId, "Deals", deal.id, "contact_to_deal");
    }
  } catch {}

  // Company — search first, create if missing, then link contact + note
  try {
    const comps = await fetch("https://api.hubapi.com/crm/v3/objects/companies/search", {
      method: "POST", headers,
      body: JSON.stringify({ filterGroups: [{ filters: [{ propertyName: "name", operator: "CONTAINS_TOKEN", value: companyName }] }] }),
    });
    const compResults = (await comps.json()).results || [];

    let compId;
    if (compResults.length > 0) {
      compId = compResults[0].id;
    } else {
      // No company found — create one
      const createComp = await fetch("https://api.hubapi.com/crm/v3/objects/companies", {
        method: "POST", headers,
        body: JSON.stringify({ properties: { name: companyName } }),
      });
      if (createComp.status === 201) {
        const created = await createComp.json();
        compId = created.id;
      } else {
        console.error("HubSpot company create failed", createComp.status, await createComp.text());
      }
    }

    if (compId) {
      await assoc("Contacts", contactId, "Companies", compId, "contact_to_company");
      await assoc("Notes",    noteId,    "Companies", compId, "note_to_company");
      const compDeals = await fetch(`https://api.hubapi.com/crm/v3/objects/companies/${compId}/associations/deals`, { headers });
      if (compDeals.status === 200) {
        for (const deal of (await compDeals.json()).results || []) {
          await assoc("Notes", noteId, "Deals", deal.id, "note_to_deal");
        }
      }
    }
  } catch {}
}

function buildNote(d, branches, submittedAt) {
  const itSame    = (d.it_same_as_champion || "").toLowerCase();
  const itContact = itSame === "yes"
    ? `<b>Same as Internal Champion</b> — ${d.champion_name || ""}`
    : `Name: ${d.it_name || ""}<br>Email: ${d.it_email || ""}`;
  const itBlock   = `${itContact}<br><br><b>POS System:</b> ${d.pos_system || ""}<br><b>Accounting SW:</b> ${d.accounting_software || ""}`;

  let branchRows = "";
  for (let i = 0; i < branches.length; i++) {
    const b     = branches[i];
    const hours = `${b.open || ""} – ${b.close || ""}`.replace(/^\s*–\s*$/, "");
    branchRows += `<tr><td style='padding:5px 8px;border-bottom:1px solid #eee'>${i + 1}</td><td style='padding:5px 8px;border-bottom:1px solid #eee'><b>${b.name || ""}</b></td><td style='padding:5px 8px;border-bottom:1px solid #eee'>${b.address || ""}</td><td style='padding:5px 8px;border-bottom:1px solid #eee'>${b.cost_center || ""}</td><td style='padding:5px 8px;border-bottom:1px solid #eee'>${hours}</td></tr>`;
  }
  const branchSection = branchRows
    ? `<table style='border-collapse:collapse;width:100%;font-size:12px'><tr style='background:#321e57;color:#fff'><th style='padding:6px 8px'>#</th><th style='padding:6px 8px'>Branch Name</th><th style='padding:6px 8px'>Address</th><th style='padding:6px 8px'>Cost Center</th><th style='padding:6px 8px'>Hours</th></tr>${branchRows}</table>`
    : "<i>No branch data provided.</i>";

  const linkCells = (label, raw) => {
    if (!raw || !raw.trim()) return `${label}: <span style='color:#aaa'>—</span>`;
    const links = raw.split(",").map(u => u.trim()).filter(Boolean);
    const anchors = links.map((u, i) =>
      `<a href='${u}' target='_blank' style='color:#503390;font-weight:600;text-decoration:none'>⬇ File ${i + 1}</a>`
    ).join(" &nbsp; ");
    return `${label}: ${anchors}`;
  };
  const filesBlock = linkCells("Invoices / Product List", d.invoices_link) + "<br>" + linkCells("Supplier Details", d.suppliers_link);

  return [
    `<h3 style='color:#321e57;margin:0 0 4px'>SUPY ONBOARDING</h3><p style='color:#888;font-size:11px;margin:0 0 16px'>Submitted: ${submittedAt}</p>`,
    `<h4 style='color:#503390;border-bottom:1px solid #e0d8f0;padding-bottom:4px;margin:14px 0 8px'>COMPANY INFO</h4>Company Name: ${d.company_name || ""}`,
    `<h4 style='color:#503390;border-bottom:1px solid #e0d8f0;padding-bottom:4px;margin:14px 0 8px'>INTERNAL CHAMPION</h4>Name: ${d.champion_name || ""}<br>Title: ${d.champion_title || ""}<br>Email: ${d.champion_email || ""}<br>Phone: ${d.champion_phone || ""}`,
    `<h4 style='color:#503390;border-bottom:1px solid #e0d8f0;padding-bottom:4px;margin:14px 0 8px'>FINANCE POC</h4>External Accounting Firm: ${d.accounting_external || ""}<br>Name: ${d.finance_name || ""}<br>Title: ${d.finance_title || ""}<br>Email: ${d.finance_email || ""}<br>Phone: ${d.finance_phone || ""}`,
    `<h4 style='color:#503390;border-bottom:1px solid #e0d8f0;padding-bottom:4px;margin:14px 0 8px'>IT &amp; SYSTEMS</h4>${itBlock}`,
    `<h4 style='color:#503390;border-bottom:1px solid #e0d8f0;padding-bottom:4px;margin:14px 0 8px'>BRANCH CONFIGURATION</h4>${branchSection}`,
    `<h4 style='color:#503390;border-bottom:1px solid #e0d8f0;padding-bottom:4px;margin:14px 0 8px'>OPERATIONS</h4>Order Method: ${d.ordering_method || ""}<br>PO Approver: ${d.po_approver || ""}<br>Ordering Structure: ${d.ordering_structure || ""}<br>Stock Counts: ${d.stock_counts || ""}<br>Stock Count Duration: ${d.stock_count_duration || ""}<br>Inventory System: ${d.inventory_system || ""}`,
    `<h4 style='color:#503390;border-bottom:1px solid #e0d8f0;padding-bottom:4px;margin:14px 0 8px'>FOOD COST</h4>Current Food Cost %: ${d.food_cost_current || ""}<br>Target Food Cost %: ${d.food_cost_target || ""}<br>COGS Method: ${d.cogs_method || ""}<br>Invoice Delivery: ${d.invoice_delivery || ""}<br>Finance Complications: ${d.finance_complications || ""}`,
    `<h4 style='color:#503390;border-bottom:1px solid #e0d8f0;padding-bottom:4px;margin:14px 0 8px'>GOALS &amp; BLOCKERS</h4>Top Problem to Solve: ${d.top_problem || ""}<br>CSM Notes: ${d.extra_notes || ""}<br>Known Blockers: ${d.blockers || ""}<br>Target Go-Live: ${d.golive_date || ""}`,
    `<h4 style='color:#503390;border-bottom:1px solid #e0d8f0;padding-bottom:4px;margin:14px 0 8px'>FILE LINKS</h4>${filesBlock}`,
  ].join("");
}

// ─────────────────────────────────────────────────────────────
// Slack
// ─────────────────────────────────────────────────────────────
async function sendSlack(env, d, branches, submittedAt, cid) {
  if (!env.SLACK_WEBHOOK_URL) return false;
  const hsLink = cid
    ? `https://app.hubspot.com/contacts/${HUBSPOT_PORTAL_ID}/record/0-1/${cid}`
    : "https://app.hubspot.com/contacts/";
  const blocks = [
    { type: "header", text: { type: "plain_text", text: "🎉 New Onboarding Submission", emoji: true } },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*Company:*\n${d.company_name || "Unknown"}` },
        { type: "mrkdwn", text: `*Champion:*\n${d.champion_name || "-"} (${d.champion_email || "-"})` },
        { type: "mrkdwn", text: `*Branches:*\n${branches.length} location(s)` },
        { type: "mrkdwn", text: `*Target Go-Live:*\n${d.golive_date || "Not specified"}` },
        { type: "mrkdwn", text: `*POS System:*\n${d.pos_system || "-"}` },
        { type: "mrkdwn", text: `*Accounting:*\n${d.accounting_software || "-"}` },
      ],
    },
    {
      type: "actions",
      elements: [{ type: "button", text: { type: "plain_text", text: "View in HubSpot", emoji: true }, style: "primary", url: hsLink }],
    },
  ];

  // Append file download buttons only when files were uploaded
  const buildFileButtons = (raw, prefix) => {
    if (!raw || !raw.trim()) return [];
    return raw.split(",").map(u => u.trim()).filter(Boolean).slice(0, 5).map((u, i) => ({
      type: "button",
      text: { type: "plain_text", text: `${prefix} ${i + 1}`, emoji: true },
      url: u,
    }));
  };
  const fileButtons = [
    ...buildFileButtons(d.invoices_link, "📎 Invoice"),
    ...buildFileButtons(d.suppliers_link, "📋 Supplier"),
  ].slice(0, 5);
  if (fileButtons.length > 0) blocks.push({ type: "actions", elements: fileButtons });
  const r = await fetch(env.SLACK_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ blocks }),
  });
  return r.status === 200;
}

// ─────────────────────────────────────────────────────────────
// Slack — hubspot-test-channel
// Fires only when champion_email === vaishnavi@supy.io
// ─────────────────────────────────────────────────────────────
async function sendSlackTestChannel(env, d, branches, submittedAt, cid) {
  if (!env.SLACK_TEST_WEBHOOK_URL) return false;
  const hsLink = cid
    ? `https://app.hubspot.com/contacts/${HUBSPOT_PORTAL_ID}/record/0-1/${cid}`
    : "https://app.hubspot.com/contacts/";

  const blocks = [
    { type: "header", text: { type: "plain_text", text: "🧪 Test Submission — vaishnavi@supy.io", emoji: true } },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*Company:*\n${d.company_name || "Unknown"}` },
        { type: "mrkdwn", text: `*Champion:*\n${d.champion_name || "-"} (${d.champion_email || "-"})` },
        { type: "mrkdwn", text: `*Branches:*\n${branches.length} location(s)` },
        { type: "mrkdwn", text: `*Target Go-Live:*\n${d.golive_date || "Not specified"}` },
        { type: "mrkdwn", text: `*POS System:*\n${d.pos_system || "-"}` },
        { type: "mrkdwn", text: `*Accounting:*\n${d.accounting_software || "-"}` },
      ],
    },
    {
      type: "actions",
      elements: [{ type: "button", text: { type: "plain_text", text: "View in HubSpot", emoji: true }, style: "primary", url: hsLink }],
    },
  ];

  const buildFileButtons = (raw, prefix) => {
    if (!raw || !raw.trim()) return [];
    return raw.split(",").map(u => u.trim()).filter(Boolean).slice(0, 5).map((u, i) => ({
      type: "button",
      text: { type: "plain_text", text: `${prefix} ${i + 1}`, emoji: true },
      url: u,
    }));
  };
  const fileButtons = [
    ...buildFileButtons(d.invoices_link, "📎 Invoice"),
    ...buildFileButtons(d.suppliers_link, "📋 Supplier"),
  ].slice(0, 5);
  if (fileButtons.length > 0) blocks.push({ type: "actions", elements: fileButtons });

  const r = await fetch(env.SLACK_TEST_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ blocks }),
  });
  return r.status === 200;
}

// ─────────────────────────────────────────────────────────────
// Gmail (OAuth2 refresh token flow)
// ─────────────────────────────────────────────────────────────
async function getGmailToken(env) {
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type:    "refresh_token",
      client_id:     env.GMAIL_CLIENT_ID,
      client_secret: env.GMAIL_CLIENT_SECRET,
      refresh_token: env.GMAIL_REFRESH_TOKEN,
    }),
  });
  if (r.status !== 200) return null;
  return (await r.json()).access_token || null;
}

async function sendEmail(env, d, branches, submittedAt, cid) {
  const token = await getGmailToken(env);
  if (!token) return false;

  const hsLink  = cid
    ? `https://app.hubspot.com/contacts/${HUBSPOT_PORTAL_ID}/record/0-1/${cid}`
    : "https://app.hubspot.com/contacts/";
  const company = d.company_name || "Unknown Company";

  const htmlBody = [
    `<h3>New Onboarding Submission</h3>`,
    `<p><b>Company:</b> ${company}<br><b>Submitted:</b> ${submittedAt}</p>`,
    `<p>A new onboarding form has been successfully logged. All branch details, POS information, and accounting setups have been recorded.</p>`,
    `<br><a href='${hsLink}' style='display:inline-block;padding:10px 15px;background-color:#321e57;color:white;text-decoration:none;border-radius:5px;'>Open Contact in HubSpot</a>`,
  ].join("");

  const mime = [
    `From: ${EMAIL_FROM}`,
    `To: ${EMAIL_RECIPIENTS.join(", ")}`,
    `Subject: New Onboarding: ${company}`,
    `MIME-Version: 1.0`,
    `Content-Type: text/html; charset=UTF-8`,
    ``,
    htmlBody,
  ].join("\r\n");

  const raw = btoa(unescape(encodeURIComponent(mime)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

  const r = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ raw }),
  });
  return r.status === 200;
}

// ─────────────────────────────────────────────────────────────
// Google Sheets (Apps Script)
// ─────────────────────────────────────────────────────────────
async function logToSheets(env, d, branches, submittedAt) {
  if (!env.GOOGLE_SCRIPT_URL) return false;
  try {
    const payload = { ...d, submitted_at: submittedAt, branch_count: branches.length };
    const r = await fetch(env.GOOGLE_SCRIPT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return r.ok;
  } catch { return false; }
}

function doPost(e) {
  try {
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Sheet1");

    var d;
    if (e.postData && e.postData.type === 'application/json') {
      d = JSON.parse(e.postData.contents);
    } else if (e.parameter && Object.keys(e.parameter).length > 0) {
      d = e.parameter;
    } else {
      try { d = JSON.parse(e.postData.contents); } catch(err) { d = {}; }
    }

    if (sheet.getLastRow() === 0) {
      var headers = [
        "Submitted At", "Draft?", "Company Name",
        "Champ Name", "Champ Title", "Champ Email", "Champ Phone",
        "Accounting", "Finance Name", "Finance Title", "Finance Email", "Finance Phone",
        "IT Same?", "IT Name", "IT Title", "IT Email", "IT Phone",
        "POS", "Acc. Software", "Branches List", "Count",
        "Invoices", "Suppliers", "Order Method", "PO Appr.", "Structure",
        "Stock Counts", "Duration", "Inventory", "Current FC%", "Target FC%",
        "COGS", "Delivery", "Complications", "Top Problem", "Notes", "Blockers", "Go-Live"
      ];
      sheet.appendRow(headers);
      sheet.getRange(1, 1, 1, headers.length).setFontWeight("bold").setBackground("#321e57").setFontColor("#ffffff");
      sheet.setFrozenRows(1);
    }

    var branches = [];
    try { branches = JSON.parse(d.branches_json || "[]"); } catch(err) {}

    var branchText = branches.map(function(b, i) {
      var name      = b.name        ? b.name.toUpperCase() : "N/A";
      var address   = b.address     ? b.address            : "N/A";
      var cc        = b.cost_center ? b.cost_center        : "N/A";
      var openTime  = b.open        ? b.open               : "--:--";
      var closeTime = b.close       ? b.close              : "--:--";
      var details   = b.details     ? b.details            : "None";
      return (i + 1) + ". " + name + "\n" +
             "   Address: " + address + "\n" +
             "   Cost Center: " + cc + "\n" +
             "   Hours: " + openTime + " to " + closeTime + "\n" +
             "   Details: " + details;
    }).join("\n\n=======================\n\n");

    function clean(val) { return val ? val : ""; }

    var isDraft = d._draft === "true" || d._autosave === "true" ? "DRAFT" : "";
    var submittedAt = clean(d.submitted_at) || clean(d._saved_at) || new Date().toISOString();

    var row = [
      submittedAt, isDraft, clean(d.company_name),
      clean(d.champion_name), clean(d.champion_title), clean(d.champion_email), clean(d.champion_phone),
      clean(d.accounting_external), clean(d.finance_name), clean(d.finance_title), clean(d.finance_email), clean(d.finance_phone),
      clean(d.it_same_as_champion), clean(d.it_name), clean(d.it_title), clean(d.it_email), clean(d.it_phone),
      clean(d.pos_system), clean(d.accounting_software),
      branchText, branches.length,
      clean(d.invoices_link), clean(d.suppliers_link),
      clean(d.ordering_method), clean(d.po_approver), clean(d.ordering_structure),
      clean(d.stock_counts), clean(d.stock_count_duration), clean(d.inventory_system),
      clean(d.food_cost_current), clean(d.food_cost_target),
      clean(d.cogs_method), clean(d.invoice_delivery), clean(d.finance_complications),
      clean(d.top_problem), clean(d.extra_notes), clean(d.blockers), clean(d.golive_date)
    ];

    var EMAIL_COL = 6;
    var email     = clean(d.champion_email).trim().toLowerCase();
    var lastRow   = sheet.getLastRow();
    var targetRow = -1;

    if (email && lastRow > 1) {
      var emailValues = sheet.getRange(2, EMAIL_COL, lastRow - 1, 1).getValues();
      for (var i = 0; i < emailValues.length; i++) {
        if ((emailValues[i][0] || "").toString().trim().toLowerCase() === email) {
          targetRow = i + 2;
          break;
        }
      }
    }

    if (targetRow > 0) {
      sheet.getRange(targetRow, 1, 1, row.length).setValues([row]);
      sheet.getRange(targetRow, 20).setWrap(true);
      sheet.getRange(targetRow, 1, 1, row.length).setBackground(isDraft ? "#fffde7" : "#ffffff");
    } else {
      sheet.appendRow(row);
      var newRow = sheet.getLastRow();
      sheet.getRange(newRow, 20).setWrap(true);
      if (isDraft) {
        sheet.getRange(newRow, 1, 1, row.length).setBackground("#fffde7");
      }
    }

    return ContentService.createTextOutput("Success");

  } catch (err) {
    return ContentService.createTextOutput("Error: " + err.message);
  }
}


function deduplicateSheet() {
  var sheet   = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Sheet1");
  var lastRow = sheet.getLastRow();
  if (lastRow <= 1) return;

  var EMAIL_COL = 6;
  var DATE_COL  = 1;
  var data = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getValues();

  var emailMap = {};
  for (var i = 0; i < data.length; i++) {
    var email = (data[i][EMAIL_COL - 1] || "").toString().trim().toLowerCase();
    var date  = (data[i][DATE_COL - 1]  || "").toString();
    if (!email) continue;
    if (!emailMap[email]) {
      emailMap[email] = { latestIndex: i, latestDate: date, allIndexes: [i] };
    } else {
      emailMap[email].allIndexes.push(i);
      if (date > emailMap[email].latestDate) {
        emailMap[email].latestIndex = i;
        emailMap[email].latestDate  = date;
      }
    }
  }

  var rowsToDelete = [];
  for (var key in emailMap) {
    var entry = emailMap[key];
    if (entry.allIndexes.length > 1) {
      for (var j = 0; j < entry.allIndexes.length; j++) {
        if (entry.allIndexes[j] !== entry.latestIndex) {
          rowsToDelete.push(entry.allIndexes[j] + 2);
        }
      }
    }
  }

  rowsToDelete.sort(function(a, b) { return b - a; });
  for (var r = 0; r < rowsToDelete.length; r++) {
    sheet.deleteRow(rowsToDelete[r]);
  }

  Logger.log("Done. Removed " + rowsToDelete.length + " duplicate row(s).");
}


var FORM_URL = "https://vaishnavi-supy-io.github.io/supy-onboarding/";

function sendDraftReminders() {
  var sheet   = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Sheet1");
  var lastRow = sheet.getLastRow();
  if (lastRow <= 1) return;

  var now      = new Date();
  var data     = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getValues();
  var reminded = 0;

  for (var i = 0; i < data.length; i++) {
    var isDraft = (data[i][1] || "").toString().trim() === "DRAFT";
    var email   = (data[i][5] || "").toString().trim();
    var name    = (data[i][3] || "there").toString().trim();
    var company = (data[i][2] || "").toString().trim();
    var savedAt = data[i][0];

    if (!isDraft || !email) continue;

    var hoursOld = (now - new Date(savedAt)) / (1000 * 60 * 60);
    if (isNaN(hoursOld) || hoursOld < 24) continue;

    var subject = "Reminder: Complete your Supy onboarding form";
    var body = "<div style='font-family:Arial,sans-serif;max-width:600px;padding:24px'>"
      + "<img src='https://supy.io/wp-content/uploads/2021/09/supy-logo.png' height='32' style='margin-bottom:20px'><br>"
      + "<p>Hi " + name + ",</p>"
      + "<p>We noticed you started filling out the Supy onboarding form"
      + (company ? " for <b>" + company + "</b>" : "") + " but have not completed it yet.</p>"
      + "<p>It only takes a few more minutes - your progress has been saved, so you can pick up right where you left off.</p>"
      + "<br><a href='" + FORM_URL + "' style='display:inline-block;padding:12px 20px;background:#321e57;color:#fff;text-decoration:none;border-radius:6px;font-weight:700'>Complete my form</a>"
      + "<br><br><p style='color:#888;font-size:11px'>If you have already submitted or need help, just reply to this email.</p>"
      + "</div>";

    try {
      GmailApp.sendEmail(email, subject, "", { htmlBody: body, name: "Supy Onboarding" });
      reminded++;
      Logger.log("Reminded: " + email);
    } catch(err) {
      Logger.log("Failed: " + email + " - " + err.message);
    }
  }

  Logger.log("Done. Reminded " + reminded + " people.");
}


function createDailyTrigger() {
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === "sendDraftReminders") ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger("sendDraftReminders").timeBased().everyDays(1).atHour(9).create();
  Logger.log("Daily trigger created - runs every day at 9am.");
}


function testDraftReminder() {
  var sheet   = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Sheet1");
  var lastRow = sheet.getLastRow();
  if (lastRow <= 1) { Logger.log("No data rows."); return; }

  var now  = new Date();
  var data = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getValues();

  for (var i = 0; i < data.length; i++) {
    var isDraft = (data[i][1] || "").toString().trim() === "DRAFT";
    var email   = (data[i][5] || "").toString().trim();
    var name    = (data[i][3] || "there").toString().trim();
    var company = (data[i][2] || "").toString().trim();
    var savedAt = data[i][0];

    if (!isDraft || !email) continue;

    var minsOld = (now - new Date(savedAt)) / (1000 * 60);
    Logger.log(email + " - draft age: " + Math.round(minsOld) + " mins");
    if (minsOld < 5) continue;

    var subject = "[TEST] Reminder: Complete your Supy onboarding form";
    var body = "<div style='font-family:Arial,sans-serif;max-width:600px;padding:24px'>"
      + "<p><b>[THIS IS A TEST EMAIL]</b></p>"
      + "<p>Hi " + name + ",</p>"
      + "<p>We noticed you started filling out the Supy onboarding form"
      + (company ? " for <b>" + company + "</b>" : "") + " but have not completed it yet.</p>"
      + "<p>Your progress has been saved - pick up right where you left off.</p>"
      + "<br><a href='" + FORM_URL + "' style='display:inline-block;padding:12px 20px;background:#321e57;color:#fff;text-decoration:none;border-radius:6px;font-weight:700'>Complete my form</a>"
      + "</div>";

    GmailApp.sendEmail("vaishnavi@supy.io", subject, "", { htmlBody: body, name: "Supy Onboarding" });
    Logger.log("Test reminder sent for: " + email);
  }
}

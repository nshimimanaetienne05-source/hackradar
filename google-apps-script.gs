// Paste this in Google Sheets > Extensions > Apps Script, then Deploy > New deployment
// > type "Web app" > Execute as: Me > Who has access: Anyone. Copy the Web app URL
// into REGISTER_ENDPOINT in index.html.

const SHEET_REGISTER = "Registrations";
const SHEET_PICKS = "Picks";

function doPost(e) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let d;
  try { d = JSON.parse(e.postData.contents); } catch (err) { return ok("bad json"); }

  if (d.type === "register") {
    sheet(ss, SHEET_REGISTER, ["Time", "Name", "Email", "Status", "Education", "Career", "Language"])
      .appendRow([d.ts, d.name, d.email, d.status, d.education, d.career, d.lang]);
  } else if (d.type === "pick" || d.type === "applied") {
    sheet(ss, SHEET_PICKS, ["Time", "Action", "Email", "Status", "Education", "Career", "Event", "Source", "Event ID"])
      .appendRow([d.ts, d.type, d.email, d.status, d.education, d.career, d.event, d.source, d.eventId]);
  }
  return ok("saved");
}

function sheet(ss, name, header) {
  let s = ss.getSheetByName(name);
  if (!s) { s = ss.insertSheet(name); s.appendRow(header); }
  return s;
}

function ok(msg) {
  return ContentService.createTextOutput(msg);
}

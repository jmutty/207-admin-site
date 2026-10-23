// renderAgreement() against Jeremiah's Apps Script v2 (agreement-builder-v2.gs.js), using the inputs of the
// Enfield Station School agreement (2026-2027). Plain node, no packages:
//   node app/test/agreement-render.test.js
// Exits non-zero on the first failed check.
const assert = require("assert");
const path = require("path");
const { AgreementDoc, renderAgreement } = require(path.join(__dirname, "..", "src", "agreement-builder.js"));

let n = 0;
const ok = (cond, what) => { assert.ok(cond, what); n++; console.log("  ok   " + what); };
const has = (text, s, what) => ok(text.includes(s), what || "has: " + s.slice(0, 90));
const hasnt = (text, s, what) => ok(!text.includes(s), what || "never shows: " + s.slice(0, 90));

// The builder sheet as filled in for Enfield Station School (values typed the way they were in the sheet).
const ENFIELD = {
  on: ["FALL", "RETAKE", "CLASS_COMP", "STAFF_PORTRAITS", "ID_CARD_STAFF", "SIS", "YEARBOOK", "CLASS_DIGITAL", "STICKERS", "ALBUM",
       "EXCLUSIVITY", "AUTORENEW", "COMM_ANNOUNCE", "COMM_FLYER", "COMM_REMINDER", "COMM_GALLERY"].reduce((o, k) => (o[k] = true, o), {}),
  val: {
    SCHOOL_NAME: "Enfield Station School", YEAR_START: "2026", YEAR_END: "2027",
    CONTACT_NAME: "Marisa LeBlanc", CONTACT_TITLE: "Admin. Asst.", CONTACT_EMAIL: "marisa.leblanc@sau31.org",
    START_DATE: "09/2026", TERM_YEARS: "1", END_YEAR: "2027", ROSTER_EMAIL: "info@207photo.com",
    FALL: "9/18/26", RETAKE: "10/14/26",
    NET_DAYS: "30", RATIO: "300", TA_GALLERY: "10", TA_FILES: "15", TA_COMPOSITE: "30", TA_CARDS: "15", TA_SHIP: "3",
    INS_OCC: "1000000", INS_AGG: "2000000", INS_SAM_AMT: "1000000",
    FIX_RATE: "75", RESCHED_FEE: "250", LIAB_CAP: "10000", COUNTY: "Penobscot",
    SPACE_SIZE: "20 ft by 30 ft", SETUP_MIN: "30", BREAKDOWN: "30",
  },
};

console.log("Enfield Station School, 2026-2027");
const { html, text } = renderAgreement(ENFIELD);
const lines = text.split("\n");
const sections = lines.filter((l) => /^\d+\. [A-Z]/.test(l));

// Header + summary table
has(text, "SCHOOL PHOTOGRAPHY SERVICE AGREEMENT");
has(text, "207 Photo & Design  |  60 Main Rd. N., Hampden, ME 04444");
has(text, "(207) 558-3185  |  jmutty@207photo.com  |  207photo.com");
has(text, "Picture Day, Done Right");
has(text, "School or SAU  |  Enfield Station School");
has(text, "Buildings covered  |  __________________________________", "blank buildings print a 34-character fill-in line");
has(text, "School year  |  2026 to 2027");
has(text, "Primary school contact  |  Marisa LeBlanc,  Admin. Asst.");
has(text, "Contact email and phone  |  marisa.leblanc@sau31.org,  ______________", "blank phone prints 14 underscores");
has(text, "Cost to the school  |  $0 for every service listed in the Services section");
has(text, "Fall picture day  |  September 18, 2026", "9/18/26 prints as September 18, 2026");
has(text, "Retake day  |  October 14, 2026   (no charge)", "10/14/26 prints as October 14, 2026");
has(text, "Term  |  1 school year, renewing automatically");
hasnt(text, "Spring picture day  |");

// Numbering: no rebate, so Exclusivity is 8 and everything after shifts like the script.
ok(JSON.stringify(sections) === JSON.stringify([
  "1. ABOUT THIS AGREEMENT", "2. SERVICES 207 PHOTO WILL PROVIDE", "3. WHAT 207 PHOTO COMMITS TO", "4. WHAT THE SCHOOL COMMITS TO",
  "5. STUDENT DATA", "6. PHOTOGRAPHS AND COPYRIGHT", "7. PRICING AND FAMILY ORDERING", "8. EXCLUSIVITY",
  "9. SCHEDULING, WEATHER AND CANCELLATION", "10. GENERAL TERMS", "11. TERM, RENEWAL AND TERMINATION", "12. SIGNATURES"]),
  "sections 1 to 12, Exclusivity is 8: " + sections.join(" / "));

// Section 1
has(text, 'This Agreement is between 207 Photo & Design, a Maine business located at 60 Main Rd. N., Hampden, ME 04444 (called "207 Photo" below), and Enfield Station School (called "the School" below).');
has(text, "It covers the 2026 to 2027 school year and any renewal term.");
// Section 2
has(text, "2.1 Session days. 207 Photo will photograph the following sessions:");
has(text, "  - Fall picture day, individual student portraits. Date: September 18, 2026.");
has(text, "  - One retake day, included at no charge. Date: October 14, 2026.");
has(text, "2.2 Group and class photography. 207 Photo will photograph:");
has(text, "  - Class and homeroom group photos, built as a digital composite from individual portraits. Made available in galleries after picture day.");
has(text, "2.3 Files and materials delivered to the School. At no cost to the School, 207 Photo will deliver:");
has(text, "  - Individual digital staff portraits for every employee photographed.");
has(text, "  - Printed staff ID cards.");
has(text, "  - Student information system import file, images named by student name with a linking index.");
has(text, "  - Yearbook file package built to the PSPA standard, images plus a tab delimited index file.");
has(text, "  - Digital class and composite files for School use.");
has(text, "  - Cumulative folder stickers.");
has(text, "  - An administrator album, a bound directory of all portraits.");
has(text, "2.4 Anything not listed. Services not described in this section are not covered by this Agreement.", "no add-ons, so Anything not listed is 2.4");
// Section 3 + turnaround table (only rows for ticked deliverables)
has(text, "3.1 Staffing and equipment. We bring everything we need: professional studio lighting, backdrops, and tethered laptops so we can check quality as we shoot. We staff at least one photographer for every 300 students scheduled in a day.");
has(text, "Deliverable  |  Business days\nOnline family galleries live  |  10\nYearbook, SIS and ID image files to the School  |  15\nPrinted composites and albums  |  30\nPrinted ID cards  |  15\nFamily orders shipped, from date of order  |  3", "turnaround rows for yearbook/SIS, album and ID cards");
has(text, "3.4 Retake day. One retake day is included at no cost.");
has(text, "3.8 Insurance. 207 Photo carries commercial general liability coverage of not less than $1,000,000 per occurrence and $2,000,000 in the aggregate. A current certificate of insurance naming the School as an additional insured is available on request.");
hasnt(text, "abuse and molestation");
has(text, "3.9 Background checks.");
// Section 4
has(text, "4.1 Roster data, due 14 calendar days before picture day at the latest. The School will send a complete student and staff roster in CSV or Excel format to info@207photo.com no later than 14 calendar days before picture day.");
has(text, "may be billed at $75 per hour");
has(text, "4.2 Parent communication. Families need advance notice");
has(text, "Communication  |  When\nAnnouncement email to all parents and guardians, using the 207 Photo template  |  10 or more days before picture day\nFlyer or graphic posted to the School website, social media, or both  |  10 or more days before picture day\nReminder email, app notification or text to all parents and guardians  |  1 to 3 days before picture day\nGallery is live email to all parents and guardians, using the 207 Photo template  |  Within 3 days of galleries going live", "parent communications table, four rows");
hasnt(text, "Inclusion in the School newsletter");
has(text, "4.3 Picture day logistics. At no cost to 207 Photo, the School will provide:");
has(text, "  - An indoor space with controllable lighting, approximately 20 ft by 30 ft, with working electrical outlets.");
has(text, "  - Building access beginning 30 minutes before scheduled start time for setup, and 30 minutes after the last session for breakdown.");
has(text, "4.4 Student privacy confirmations.");
// 5-7
has(text, "5.8 Communications with families.");
has(text, "6.2 The School license.");
has(text, "7.1 No cost to the School.");
has(text, "7.2 Promotions.", "no price list, so Promotions is 7.2");
has(text, "7.4 Family support.", "no school purchases, so Family support is 7.4");
// 8 Exclusivity
has(text, "8. EXCLUSIVITY\n\nFor the term of this Agreement, 207 Photo is the exclusive provider");
has(text, "  - Senior portraits arranged privately by individual families with a photographer of their choosing.");
// 9-11
has(text, "9.1 Rescheduling by the School.");
has(text, "a rescheduling fee of $250 may apply.");
has(text, "limited to the greater of $10,000 or the total amount");
has(text, "Venue for any dispute lies in the courts of Penobscot County, Maine.");
has(text, "10.9 Entire agreement. This Agreement, together with any signed addendum, is the entire agreement", "no price list mention in Entire agreement");
has(text, "11.1 Initial term. This Agreement begins on September 1, 2026 and runs through June 30, 2027, covering 1 school year.", "START_DATE 09/2026 prints as September 1, 2026 (the sheet reads it as a date)");
has(text, "11.2 Automatic renewal.");
has(text, "11.3 Termination for convenience.");
// 12 Signatures
has(text, "12. SIGNATURES\n\nBy signing below, each party confirms it has read this Agreement");
has(text, "SCHOOL OR SCHOOL ADMINISTRATIVE UNIT\n\nOrganization  |  Enfield Station School\nSignature  |   \nTitle  |   \nDate  |   \nEmail and phone  |  marisa.leblanc@sau31.org,  ______________\nBilling address  |  ______________________________");
has(text, "207 PHOTO & DESIGN\n\nSignature  |   \nPrinted name  |  Jeremiah Mutty\nTitle  |  Owner / Chief Creative Officer\nDate  |   \nEmail and phone  |  jmutty@207photo.com,  (207) 558-3185");
has(text, "207 Photo & Design  |  207photo.com  |  Picture Day, Done Right");

// Nothing unticked shows up.
[["Spring picture day, individual student portraits"], ["Graduation or cap and gown photography"], ["Underclass or senior portrait day"],
 ["Additional session day"], ["traditional posed"], ["Staff and faculty group photo"], ["Club, band, chorus"], ["Athletic team and individual photos"],
 ["Senior class panoramic"], ["School board and administration photos"], ["Staff ID badge image files"], ["Student ID badge image files"],
 ["Printed student ID cards"], ["A printed class composite for each classroom"], ["A digital portrait archive"], ["A marketing image bundle"],
 ["Additional services"], ["Senior athlete banners"], ["Music and arts program banners"], ["Event coverage"], ["207 Graduation Signs"],
 ["Price list"], ["FAMILY PRICE LIST"], ["School purchases"], ["FUNDRAISING AND REBATE"], ["rebate"], ["Families with financial need"],
 ["KEY DATES WORKSHEET"], ["the attached price list"]].forEach(([s]) => hasnt(text, s, "unticked never appears: " + s));

// HTML: brand look and the same numbering.
has(html, '<h2 class="ab-sec">8. EXCLUSIVITY</h2>');
has(html, '<h2 class="ab-sec">12. SIGNATURES</h2>');
has(html, '<p class="ab-p ab-sub"><b>2.1 Session days. </b>207 Photo will photograph the following sessions:</p>');
has(html, "Marisa LeBlanc, &nbsp;Admin. Asst.", "double space after the comma kept in HTML");
ok(!/<(script|style|a|img|iframe)\b/i.test(html) && !/ (style|href|src|on\w+)=/i.test(html), "HTML holds only plain tags and ab- classes");
ok((html.match(/class="([^"]*)"/g) || []).every((c) => c.slice(7, -1).split(" ").every((x) => /^ab-[a-z0-9-]+$/.test(x))), "every class is an ab- class");

console.log("Everything ticked: the conditional sections renumber like the script");
{
  const all = { on: {}, val: { SCHOOL_NAME: "Hancock Grammar School", YEAR_START: "2026", YEAR_END: "2027", REBATE_PCT: "12.5", REBATE_FLAT: "2", REBATE_DEST: "the PTO",
    FRL: "Basic", FRL_QTY: "40", PO_NUMBER: "PO-0077", NET_DAYS: "30", INS_SAM_AMT: "1000000", INS_OCC: "1,000,000", COMM_OTHER: "Robocall", TERM_YEARS: "3" } };
  AgreementDoc.SPEC.forEach((s) => { if (s.t === "service") all.on[s.key] = true; });
  const t = renderAgreement(all).text;
  const secs = t.split("\n").filter((l) => /^\d+\. [A-Z]/.test(l));
  ok(secs[7] === "8. FUNDRAISING AND REBATE" && secs[8] === "9. EXCLUSIVITY" && secs[9] === "10. SCHEDULING, WEATHER AND CANCELLATION" && secs[12] === "13. SIGNATURES" && secs.length === 13, "rebate is 8, exclusivity 9, signatures 13");
  has(t, "8.1 Rebate. The School will receive a rebate of 12.5 percent of net sales, plus $2 per completed order.");
  has(t, "paid within 30 days by check to the School, designated for the PTO.");
  has(t, "8.2 Families with financial need. 207 Photo will provide a complimentary Basic package to families the School identifies as eligible, up to 40 students per school year.");
  has(t, "We also carry abuse and molestation liability coverage of not less than $1,000,000 per occurrence.");
  has(t, "7.2 Price list.");
  has(t, "net 30 days. Purchase order number: PO-0077.");
  has(t, "This Agreement, together with the attached price list and any signed addendum, is");
  has(t, "Robocall  |  ______________");
  has(t, "FAMILY PRICE LIST");
  has(t, "This page forms part of the School Photography Service Agreement between 207 Photo & Design and Hancock Grammar School for the 2026 to 2027 school year.");
  has(t, "KEY DATES WORKSHEET");
  has(t, "Milestone  |  Date  |  Who\nAgreement signed  |  ____________  |  Both");
  has(t, "Composites and albums delivered  |  ____________  |  207 Photo");
  has(t, "covering 3 school years.");
  has(t, "  - Additional session day.", "ADDL without a description");
  has(t, "  - Additional services as agreed in writing.", "OTHER without a description");
}

console.log("Rebate without the percent, and blanks");
{
  const t = renderAgreement({ on: { REBATE_FLAT: true }, val: {} }).text;
  const secs = t.split("\n").filter((l) => /^\d+\. [A-Z]/.test(l));
  ok(secs[7] === "8. FUNDRAISING AND REBATE" && secs[8] === "9. SCHEDULING, WEATHER AND CANCELLATION", "no exclusivity: scheduling follows the rebate");
  has(t, "8.1 Rebate. The School will receive a rebate of $____ per completed order.");
  has(t, "School year  |  ______ to ______");
  has(t, "Term  |  ___ school years", "blank term prints the yearsPhrase fill-in");
  has(t, "Organization  |  ______________________________");
  has(t, "This Agreement begins on ________________ and runs through June 30, ______, covering ___ school years.");
}

console.log("commas() and yearsPhrase() match the script");
ok(AgreementDoc.commas("1000000") === "1,000,000" && AgreementDoc.commas("75") === "75" && AgreementDoc.commas("10000.5") === "10,000.5" && AgreementDoc.commas("n/a") === "n/a", "commas");
ok(AgreementDoc.yearsPhrase("1") === "1 school year" && AgreementDoc.yearsPhrase("2") === "2 school years" && AgreementDoc.yearsPhrase("") === "___ school years", "yearsPhrase");
ok(AgreementDoc.normalize({ val: { FALL: "2026-09-18", RETAKE: "10/14/2026", LIAB_CAP: "10,000", START_DATE: "13/2026" } }).val.FALL === "September 18, 2026", "a date box (ISO) prints like the sheet");
ok(AgreementDoc.normalize({ val: { START_DATE: "13/2026" } }).val.START_DATE === "13/2026", "not a date stays as typed");
ok(AgreementDoc.docTitle(ENFIELD) === "School Photography Service Agreement 2026-2027", "title like the script's doc name");
ok(AgreementDoc.DEFAULT_ON.length === 13 && AgreementDoc.SPEC.filter((s) => s.key).length === 79, "SPEC keys and DEFAULT_ON as in the script");

console.log("ALL " + n + " AGREEMENT RENDER CHECKS PASSED");

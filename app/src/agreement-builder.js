  // ================================================================ AGREEMENT BUILDER (2026-10-24, ws/agreement)
  // School agreements built the way Jeremiah's "207 Photo School Agreement Builder" sheet does it: tick the
  // services, fill the blanks, and only what is ticked shows up. A straight port of his Apps Script v2
  // ("Matches the Hancock Grammar School edits", /mnt/project-files/agreement-builder/agreement-builder-v2.gs.js):
  // the same SPEC keys, labels, DEFAULT_ON, defaults, conditional sections, SEC/SUB numbering and wording.
  // The Google Doc becomes HTML (doc_html) + plain text (doc_text) on partner_agreements, read and accepted on
  // the existing #agree/<token> page. Database: supabase/migrations/20261024050000_agreement_builder.sql.
  //
  //   AgreementDoc      pure: SPEC, normalize (the sheet's readBuilder), renderAgreement(d) -> {html, text},
  //                     sanitize(html) for showing stored markup. No DOM at load, so `node` can require this file
  //                     (app/test/agreement-render.test.js).
  //   AgreementBuilder  the dialog: AgreementBuilder.open(orgId, {id, copyFrom, onDone}).

  const AgreementDoc = (function () {
    const BRAND = { orange: "#E16239", charcoal: "#252720", cream: "#FFF9EE", rule: "#DDD6CC" };
    const STUDIO = {
      name: "207 Photo & Design",
      address: "60 Main Rd. N., Hampden, ME 04444",
      phone: "(207) 558-3185",
      email: "jmutty@207photo.com",
      site: "207photo.com",
      signer: "Jeremiah Mutty",
      title: "Owner / Chief Creative Officer",
    };

    // The sheet, row for row. t: title | note | head | field | service.
    const SPEC = [
      { t: "title", label: "207 PHOTO SCHOOL AGREEMENT BUILDER" },
      { t: "note", label: "Check a service and it appears in the agreement. Leave it unchecked and the school never sees it. Blanks you leave empty print as fill-in lines." },

      { t: "head", label: "SCHOOL INFORMATION" },
      { t: "field", key: "SCHOOL_NAME", label: "School or SAU legal name" },
      { t: "field", key: "BUILDINGS", label: "Buildings covered" },
      { t: "field", key: "YEAR_START", label: "School year starts (year)", val: "2026" },
      { t: "field", key: "YEAR_END", label: "School year ends (year)", val: "2027" },
      { t: "field", key: "CONTACT_NAME", label: "Primary school contact name" },
      { t: "field", key: "CONTACT_TITLE", label: "Contact title" },
      { t: "field", key: "CONTACT_EMAIL", label: "Contact email" },
      { t: "field", key: "CONTACT_PHONE", label: "Contact phone" },
      { t: "field", key: "BILLING_ADDR", label: "School billing address" },

      { t: "head", label: "TERM" },
      { t: "field", key: "START_DATE", label: "Agreement start date" },
      { t: "field", key: "TERM_YEARS", label: "Initial term, number of school years", val: "1" },
      { t: "field", key: "END_YEAR", label: "Runs through June 30 of (year)", val: "2027" },
      { t: "field", key: "ROSTER_EMAIL", label: "Send roster data to", val: "info@207photo.com" },

      { t: "head", label: "SESSION DAYS" },
      { t: "service", key: "FALL", label: "Fall picture day, individual portraits" },
      { t: "service", key: "SPRING", label: "Spring picture day, individual portraits" },
      { t: "service", key: "RETAKE", label: "Retake day, included at no charge" },
      { t: "service", key: "GRAD", label: "Graduation or cap and gown day" },
      { t: "service", key: "SENIOR", label: "Underclass or senior portrait day" },
      { t: "service", key: "ADDL", label: "Additional session day (put the description in the box to the right)" },

      { t: "head", label: "GROUP AND CLASS PHOTOGRAPHY" },
      { t: "service", key: "CLASS_TRAD", label: "Class or homeroom group photos, traditional posed" },
      { t: "service", key: "CLASS_COMP", label: "Class or homeroom group photos, digital composite" },
      { t: "service", key: "STAFF_GROUP", label: "Staff or faculty group photo" },
      { t: "service", key: "CLUBS", label: "Club, band, chorus and organization photos" },
      { t: "service", key: "ATHLETICS", label: "Athletic team and individual photos" },
      { t: "service", key: "PANORAMIC", label: "Senior class panoramic or composite" },
      { t: "service", key: "BOARD", label: "School board or administration photos" },

      { t: "head", label: "STAFF AND ADMINISTRATIVE DELIVERABLES" },
      { t: "service", key: "STAFF_PORTRAITS", label: "Individual digital staff portraits" },
      { t: "service", key: "STAFF_BADGE", label: "Staff ID badge image files" },
      { t: "service", key: "STUDENT_BADGE", label: "Student ID badge image files" },
      { t: "service", key: "ID_CARD_STUDENT", label: "Printed student ID cards" },
      { t: "service", key: "ID_CARD_STAFF", label: "Printed staff ID cards" },
      { t: "service", key: "SIS", label: "SIS import file" },
      { t: "service", key: "YEARBOOK", label: "Yearbook file package, PSPA standard" },
      { t: "service", key: "CLASS_DIGITAL", label: "Digital class or composite files for school use" },
      { t: "service", key: "CLASS_PRINT", label: "Printed class composite for each classroom" },
      { t: "service", key: "STICKERS", label: "Cumulative folder stickers" },
      { t: "service", key: "ALBUM", label: "Administrator album" },
      { t: "service", key: "ARCHIVE", label: "Digital portrait archive for school records" },
      { t: "service", key: "CUTOUTS", label: "Marketing image bundle, background removed PNGs" },

      { t: "head", label: "ADD ONS" },
      { t: "service", key: "BANNERS_ATH", label: "Senior athlete banners" },
      { t: "service", key: "BANNERS_ARTS", label: "Music or arts program banners" },
      { t: "service", key: "EVENT", label: "Event coverage (describe in the box to the right)" },
      { t: "service", key: "GRAD_SIGNS", label: "Graduation signs through 207 Graduation Signs" },
      { t: "service", key: "OTHER", label: "Other (describe in the box to the right)" },

      { t: "head", label: "MONEY TERMS (hidden from the school unless checked)" },
      { t: "service", key: "PRICELIST", label: "Attach a family price list (adds the price list clause and page)" },
      { t: "service", key: "REBATE_PCT", label: "Rebate as a percentage of net sales" },
      { t: "service", key: "REBATE_FLAT", label: "Rebate as a flat amount per completed order" },
      { t: "field", key: "REBATE_DEST", label: "    Rebate designated for (fund or program)" },
      { t: "service", key: "FRL", label: "Free or reduced lunch complimentary package (name it in the box)" },
      { t: "field", key: "FRL_QTY", label: "    Maximum students per year" },
      { t: "service", key: "SCHOOL_BUYS", label: "School buys items directly (banners, extra cards, albums)" },
      { t: "field", key: "NET_DAYS", label: "    Invoice terms, net days", val: "30" },
      { t: "field", key: "PO_NUMBER", label: "    Purchase order number if required" },

      { t: "head", label: "OUR COMMITMENTS (defaults are fine for most schools)" },
      { t: "field", key: "RATIO", label: "Photographers, one per how many students", val: "300" },
      { t: "field", key: "TA_GALLERY", label: "Galleries live, business days", val: "10" },
      { t: "field", key: "TA_FILES", label: "Yearbook, SIS and ID files, business days", val: "15" },
      { t: "field", key: "TA_COMPOSITE", label: "Printed composites and album, business days", val: "30" },
      { t: "field", key: "TA_CARDS", label: "Printed ID cards, business days", val: "15" },
      { t: "field", key: "TA_SHIP", label: "Family orders shipped, business days", val: "3" },
      { t: "field", key: "INS_OCC", label: "Liability insurance per occurrence", val: "1000000" },
      { t: "field", key: "INS_AGG", label: "Liability insurance aggregate", val: "2000000" },
      { t: "service", key: "INS_SAM", label: "Include abuse and molestation coverage clause (only if you carry it)" },
      { t: "field", key: "INS_SAM_AMT", label: "    Abuse and molestation limit per occurrence", val: "1000000" },

      { t: "head", label: "PROTECTIVE TERMS" },
      { t: "field", key: "FIX_RATE", label: "Data correction rate per hour", val: "75" },
      { t: "field", key: "RESCHED_FEE", label: "Late reschedule fee", val: "250" },
      { t: "field", key: "LIAB_CAP", label: "Liability cap floor", val: "10000" },
      { t: "field", key: "COUNTY", label: "Venue county", val: "Penobscot" },
      { t: "service", key: "EXCLUSIVITY", label: "Include the exclusivity section" },
      { t: "service", key: "AUTORENEW", label: "Include automatic renewal" },

      { t: "head", label: "PICTURE DAY LOGISTICS" },
      { t: "field", key: "SPACE_SIZE", label: "Space needed, approximate size", val: "20 ft by 30 ft" },
      { t: "field", key: "SETUP_MIN", label: "Setup access, minutes before start time", val: "30" },
      { t: "field", key: "BREAKDOWN", label: "Breakdown time needed, minutes", val: "30" },

      { t: "head", label: "PARENT COMMUNICATIONS THE SCHOOL MUST SEND" },
      { t: "service", key: "COMM_ANNOUNCE", label: "Announcement email to all parents, 10+ days out" },
      { t: "service", key: "COMM_FLYER", label: "Flyer or graphic on the school website or social media" },
      { t: "service", key: "COMM_REMINDER", label: "Reminder email, app or SMS push, 1 to 3 days out" },
      { t: "service", key: "COMM_GALLERY", label: "Gallery is live email to all parents" },
      { t: "service", key: "COMM_NEWS", label: "Inclusion in newsletter, parent portal or district app" },
      { t: "service", key: "COMM_OTHER", label: "Other (describe in the box to the right)" },

      { t: "head", label: "EXTRAS" },
      { t: "service", key: "WORKSHEET", label: "Add the key dates worksheet at the end" },
    ];

    /* Services that carry a date in column C */
    const DATE_KEYS = ["FALL", "SPRING", "RETAKE", "GRAD", "SENIOR", "ADDL"];
    /* Values printed with thousands separators */
    const MONEY_KEYS = ["INS_OCC", "INS_AGG", "INS_SAM_AMT", "LIAB_CAP", "RESCHED_FEE", "FIX_RATE"];
    /* Defaults switched on for a new school */
    const DEFAULT_ON = ["FALL", "RETAKE", "CLASS_COMP", "STAFF_PORTRAITS", "SIS", "YEARBOOK",
      "CLASS_DIGITAL", "EXCLUSIVITY", "AUTORENEW",
      "COMM_ANNOUNCE", "COMM_FLYER", "COMM_REMINDER", "COMM_GALLERY"];
    /* What "Clear School Fields" keeps: the studio's standing terms (Settings > agreement_defaults). */
    const KEEP = ["YEAR_START", "YEAR_END", "END_YEAR", "ROSTER_EMAIL", "RATIO", "TA_GALLERY", "TA_FILES",
      "TA_COMPOSITE", "TA_CARDS", "TA_SHIP", "INS_OCC", "INS_AGG", "INS_SAM_AMT", "FIX_RATE",
      "RESCHED_FEE", "LIAB_CAP", "COUNTY", "SPACE_SIZE", "SETUP_MIN", "BREAKDOWN", "NET_DAYS", "TERM_YEARS"];
    /* The ones that come from the settings row (agreement_defaults) so they can be changed once for everyone. */
    const STANDARD_KEYS = ["RATIO", "TA_GALLERY", "TA_FILES", "TA_COMPOSITE", "TA_CARDS", "TA_SHIP", "INS_OCC", "INS_AGG", "INS_SAM_AMT",
      "FIX_RATE", "RESCHED_FEE", "LIAB_CAP", "COUNTY", "SPACE_SIZE", "SETUP_MIN", "BREAKDOWN", "NET_DAYS", "ROSTER_EMAIL"];
    /* Ticked staff and administrative deliverables become the job's deliverables (booking_deliverables labels). */
    const DELIVERABLES = {
      STAFF_PORTRAITS: "Staff portraits", STAFF_BADGE: "Staff ID badge files", STUDENT_BADGE: "Student ID badge files",
      ID_CARD_STUDENT: "Printed student ID cards", ID_CARD_STAFF: "Printed staff ID cards", SIS: "SIS import file",
      YEARBOOK: "Yearbook files", CLASS_DIGITAL: "Digital class composites", CLASS_PRINT: "Printed class composites",
      STICKERS: "Cumulative folder stickers", ALBUM: "Administrator album", ARCHIVE: "Digital portrait archive",
      CUTOUTS: "Marketing image bundle",
    };

    function specDefaults() {
      const on = {}, val = {};
      SPEC.forEach((s) => {
        if (s.t === "service" && DEFAULT_ON.indexOf(s.key) >= 0) on[s.key] = true;
        if (s.val) val[s.key] = s.val;
      });
      return { on, val };
    }

    // ---------------------------------------------------------------- reading the values (readBuilder)
    function commas(x) {
      const s = String(x);
      if (!/^\d+(\.\d+)?$/.test(s)) return s;
      const p = s.split(".");
      p[0] = p[0].replace(/\B(?=(\d{3})+(?!\d))/g, ",");
      return p.join(".");
    }
    const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
    // What Google Sheets turns into a date when typed into a cell, printed as the script does ('MMMM d, yyyy'):
    // 2026-09-18 (a date box), 9/18/26, 9/18/2026, and month/year like 09/2026 (the 1st of that month).
    function sheetDate(s) {
      let y, m, d, mm;
      if ((mm = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s))) { y = +mm[1]; m = +mm[2]; d = +mm[3]; }
      else if ((mm = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(s))) { m = +mm[1]; d = +mm[2]; y = +mm[3]; if (mm[3].length === 2) y += y < 30 ? 2000 : 1900; }
      else if ((mm = /^(\d{1,2})\/(\d{4})$/.exec(s))) { m = +mm[1]; d = 1; y = +mm[2]; }
      else return null;
      if (m < 1 || m > 12 || d < 1 || d > new Date(Date.UTC(y, m, 0)).getUTCDate()) return null;
      return MONTHS[m - 1] + " " + d + ", " + y;
    }
    // ISO yyyy-mm-dd of a typed or picked date (for the date boxes and picture_day); "" when it isn't one.
    function isoOf(raw) {
      const s = sheetDate(String(raw || "").trim());
      if (!s) return "";
      const mm = /^(\w+) (\d+), (\d+)$/.exec(s);
      return mm[3] + "-" + String(MONTHS.indexOf(mm[1]) + 1).padStart(2, "0") + "-" + String(mm[2]).padStart(2, "0");
    }
    // readBuilder(): {on, val} with every value as the doc prints it; blanks dropped.
    // Differences from the sheet, on purpose: a typed number keeps its decimals and leading zeros (the sheet
    // rounds 12.5 to 13 and drops the 0 of a PO number); money keys still get thousands separators.
    function normalize(input) {
      const out = { on: {}, val: {} };
      const on = (input && input.on) || {}, val = (input && input.val) || {};
      Object.keys(on).forEach((k) => { if (on[k] === true) out.on[k] = true; });
      Object.keys(val).forEach((key) => {
        let v = val[key];
        v = String(v === null || v === undefined ? "" : v).trim();
        const asDate = sheetDate(v);
        if (asDate) v = asDate;
        else if (MONEY_KEYS.indexOf(key) >= 0) v = commas(v.replace(/,/g, ""));
        if (v) out.val[key] = v;
      });
      return out;
    }

    // ---------------------------------------------------------------- the document (buildDoc)
    const escH = (v) => String(v === null || v === undefined ? "" : v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    // Escaped, with the script's double spaces kept ("Name,  Title"). "=" and "javascript:" are written as
    // entities so typed text can never look like markup to the server's check (agreement_html_ok).
    const txt = (v) => escH(v).replace(/ {2}/g, " &nbsp;").replace(/=/g, "&#61;").replace(/(javascript):/gi, "$1&#58;");

    function line(n) { let s = ""; for (let i = 0; i < (n || 24); i++) s += "_"; return s; }
    function V(d, key, width) { return d.val[key] ? d.val[key] : line(width || 20); }
    function yearsPhrase(n) {
      const v = parseInt(n, 10);
      if (!v || isNaN(v)) return line(3) + " school years";
      return v === 1 ? "1 school year" : v + " school years";
    }

    function renderAgreement(input) {
      const d = normalize(input);
      const on = d.on;
      const H = [], T = [];
      let SEC = 0, SUB = 0, inList = false;
      const endList = () => { if (inList) { H.push("</ul>"); inList = false; } };
      const out = (html, text) => { endList(); H.push(html); T.push(text); };

      // para(text, opts): cls picks the look the script set with size / color / bold.
      function para(text, opts) {
        opts = opts || {};
        const cls = ["ab-p"].concat(opts.cls || []).concat(opts.bold ? ["ab-b"] : []).concat(opts.before === 2 || opts.before === 4 ? ["ab-tight"] : []);
        if (opts.tag) out("<" + opts.tag + ' class="' + cls.join(" ") + '">' + txt(text) + "</" + opts.tag + ">", text);
        else out('<p class="' + cls.join(" ") + '">' + txt(text) + "</p>", text);
      }
      function section(title) {
        SEC++; SUB = 0;
        const t = SEC + ". " + title.toUpperCase();
        out('<h2 class="ab-sec">' + txt(t) + "</h2>", "\n" + t);
        return SEC;
      }
      function sub(title, text) {
        SUB++;
        const label = SEC + "." + SUB + " " + title;
        out('<p class="ab-p ab-sub"><b>' + txt(label + ". ") + "</b>" + (text ? txt(text) : "") + "</p>", label + ". " + (text || ""));
      }
      function bullet(text, opts) {
        opts = opts || {};
        if (!inList) { H.push('<ul class="ab-ul">'); inList = true; }
        H.push("<li>" + (opts.bold ? "<b>" + txt(text) + "</b>" : txt(text)) + "</li>");
        T.push("  - " + text);
      }
      function rule() { out('<hr class="ab-hr" />', "----------------------------------------"); }
      // Two column table. boldValue true = bold both columns (default); false = bold the label column only.
      function kvTable(rows, opts) {
        opts = opts || {};
        const boldValue = opts.boldValue === undefined ? true : opts.boldValue;
        const h = rows.map((r, i) => "<tr>" + r.map((c, ci) => {
          const b = ci === 0 || boldValue || i === 0;
          return "<td" + (b ? ' class="ab-b"' : "") + ">" + txt(c) + "</td>";
        }).join("") + "</tr>").join("");
        out('<table class="ab-table ' + (opts.labelWidth === 330 ? "ab-w330" : "ab-w190") + '"><tbody>' + h + "</tbody></table>",
          rows.map((r) => r.join("  |  ")).join("\n"));
      }
      function pageBreak() { out('<div class="ab-break"></div>', "\n========================================\n"); }

      const yrs = (d.val.YEAR_START || line(6)) + " to " + (d.val.YEAR_END || line(6));

      /* ---------- HEADER ---------- */
      para("SCHOOL PHOTOGRAPHY SERVICE AGREEMENT", { tag: "h1", cls: ["ab-title"] });
      para(STUDIO.name + "  |  " + STUDIO.address, { cls: ["ab-studio"] });
      para(STUDIO.phone + "  |  " + STUDIO.email + "  |  " + STUDIO.site, { cls: ["ab-studio"] });
      para("Picture Day, Done Right", { cls: ["ab-tag"] });
      rule();

      /* ---------- SUMMARY TABLE ---------- */
      const rows = [
        ["School or SAU", V(d, "SCHOOL_NAME", 34)],
        ["Buildings covered", V(d, "BUILDINGS", 34)],
        ["School year", yrs],
        ["Primary school contact", V(d, "CONTACT_NAME", 22) + ",  " + V(d, "CONTACT_TITLE", 18)],
        ["Contact email and phone", V(d, "CONTACT_EMAIL", 22) + ",  " + V(d, "CONTACT_PHONE", 14)],
        ["Cost to the school", "$0 for every service listed in the Services section"],
      ];
      if (on.FALL) rows.push(["Fall picture day", V(d, "FALL", 16)]);
      if (on.SPRING) rows.push(["Spring picture day", V(d, "SPRING", 16)]);
      if (on.RETAKE) rows.push(["Retake day", V(d, "RETAKE", 16) + "   (no charge)"]);
      rows.push(["Roster data due", "14 days before picture day at the latest"]);
      rows.push(["Parent announcement due", "10 days before picture day at the latest"]);
      rows.push(["Term", yearsPhrase(d.val.TERM_YEARS) + (on.AUTORENEW ? ", renewing automatically" : "")]);
      kvTable(rows);

      /* ---------- 1. ABOUT ---------- */
      section("About This Agreement");
      para("This Agreement is between " + STUDIO.name + ", a Maine business located at " + STUDIO.address +
        ' (called "207 Photo" below), and ' + V(d, "SCHOOL_NAME", 30) + ' (called "the School" below).');
      para("We are a family owned Maine studio that works with schools and sports leagues across the state. " +
        "We limit how many school partners we take on so that each one gets real attention. " +
        "This Agreement sets out what we provide, what we need from the School, and when we need it.");
      para("It covers the " + yrs + " school year and any renewal term.");

      /* ---------- 2. SERVICES ---------- */
      section("Services 207 Photo Will Provide");
      para("207 Photo will provide the following services to the School during the term of this Agreement, " +
        "at no cost to the School unless this Agreement says otherwise.");

      const sessions = [];
      if (on.FALL) sessions.push("Fall picture day, individual student portraits. Date: " + V(d, "FALL", 16) + ".");
      if (on.SPRING) sessions.push("Spring picture day, individual student portraits. Date: " + V(d, "SPRING", 16) + ".");
      if (on.RETAKE) sessions.push("One retake day, included at no charge. Date: " + V(d, "RETAKE", 16) + ".");
      if (on.GRAD) sessions.push("Graduation or cap and gown photography. Date: " + V(d, "GRAD", 16) + ".");
      if (on.SENIOR) sessions.push("Underclass or senior portrait day. Date: " + V(d, "SENIOR", 16) + ".");
      if (on.ADDL) sessions.push((d.val.ADDL || "Additional session day") + ".");
      if (sessions.length) {
        sub("Session days", "207 Photo will photograph the following sessions:");
        sessions.forEach((s) => bullet(s));
      }

      const groups = [];
      if (on.CLASS_TRAD) groups.push("Class and homeroom group photos, traditional posed.");
      if (on.CLASS_COMP) groups.push("Class and homeroom group photos, built as a digital composite from individual portraits. Made available in galleries after picture day.");
      if (on.STAFF_GROUP) groups.push("Staff and faculty group photo.");
      if (on.CLUBS) groups.push("Club, band, chorus and organization photos" + (d.val.CLUBS ? ". " + d.val.CLUBS : "."));
      if (on.ATHLETICS) groups.push("Athletic team and individual photos" + (d.val.ATHLETICS ? ", covering " + d.val.ATHLETICS + "." : "."));
      if (on.PANORAMIC) groups.push("Senior class panoramic or composite.");
      if (on.BOARD) groups.push("School board and administration photos.");
      if (groups.length) {
        sub("Group and class photography", "207 Photo will photograph:");
        groups.forEach((g) => bullet(g));
      }

      const deliv = [];
      if (on.STAFF_PORTRAITS) deliv.push("Individual digital staff portraits for every employee photographed.");
      if (on.STAFF_BADGE) deliv.push("Staff ID badge image files, cropped and named to the School specification.");
      if (on.STUDENT_BADGE) deliv.push("Student ID badge image files, cropped and named to the School specification.");
      if (on.ID_CARD_STUDENT) deliv.push("Printed student ID cards, approximately 3.375 by 2.125 inches, laminated" + (d.val.ID_CARD_STUDENT ? ". Quantity: " + d.val.ID_CARD_STUDENT + "." : "."));
      if (on.ID_CARD_STAFF) deliv.push("Printed staff ID cards" + (d.val.ID_CARD_STAFF ? ". Quantity: " + d.val.ID_CARD_STAFF + "." : "."));
      if (on.SIS) deliv.push("Student information system import file, images named by student name with a linking index" + (d.val.SIS ? ", formatted for " + d.val.SIS + "." : "."));
      if (on.YEARBOOK) deliv.push("Yearbook file package built to the PSPA standard, images plus a tab delimited index file" + (d.val.YEARBOOK ? ", formatted for " + d.val.YEARBOOK + "." : "."));
      if (on.CLASS_DIGITAL) deliv.push("Digital class and composite files for School use.");
      if (on.CLASS_PRINT) deliv.push("A printed class composite for each classroom" + (d.val.CLASS_PRINT ? ". Quantity: " + d.val.CLASS_PRINT + "." : "."));
      if (on.STICKERS) deliv.push("Cumulative folder stickers" + (d.val.STICKERS ? ", " + d.val.STICKERS + " per student." : "."));
      if (on.ALBUM) deliv.push("An administrator album, a bound directory of all portraits" + (d.val.ALBUM ? ". Quantity: " + d.val.ALBUM + "." : "."));
      if (on.ARCHIVE) deliv.push("A digital portrait archive for School records use.");
      if (on.CUTOUTS) deliv.push("A marketing image bundle, background removed PNG files the School can use on its own social media.");
      if (deliv.length) {
        sub("Files and materials delivered to the School", "At no cost to the School, 207 Photo will deliver:");
        deliv.forEach((k) => bullet(k));
      }

      const addons = [];
      if (on.BANNERS_ATH) addons.push("Senior athlete banners, custom designed, large format.");
      if (on.BANNERS_ARTS) addons.push("Music and arts program banners.");
      if (on.EVENT) addons.push("Event coverage" + (d.val.EVENT ? ": " + d.val.EVENT + "." : "."));
      if (on.GRAD_SIGNS) addons.push("Custom graduation yard signs through 207 Graduation Signs, a separate 207 Photo program with its own ordering and fundraising terms.");
      if (on.OTHER) addons.push(d.val.OTHER || "Additional services as agreed in writing.");
      if (addons.length) {
        sub("Additional services", "207 Photo will also provide:");
        addons.forEach((a) => bullet(a));
      }

      sub("Anything not listed", "Services not described in this section are not covered by this Agreement. " +
        "207 Photo is glad to quote additional work separately, and any addition takes effect once both parties sign a written amendment.");

      /* ---------- 3. WHAT 207 PHOTO COMMITS TO ---------- */
      section("What 207 Photo Commits To");

      sub("Staffing and equipment", "We bring everything we need: professional studio lighting, backdrops, " +
        "and tethered laptops so we can check quality as we shoot. We staff at least one photographer for every " +
        V(d, "RATIO", 4) + " students scheduled in a day. Every person we send into the building is a trained member of our team.");

      sub("Quality control on site", "Every frame is reviewed on a calibrated laptop as it is captured. " +
        "Nobody leaves the chair with an unusable photo.");

      sub("Turnaround", "The clock on each item below starts on the later of two events: the picture day itself, " +
        "or the day 207 Photo receives complete and correct roster data from the School.");

      const trows = [["Deliverable", "Business days"]];
      trows.push(["Online family galleries live", V(d, "TA_GALLERY", 4)]);
      if (on.YEARBOOK || on.SIS || on.STAFF_BADGE || on.STUDENT_BADGE) {
        trows.push(["Yearbook, SIS and ID image files to the School", V(d, "TA_FILES", 4)]);
      }
      if (on.CLASS_PRINT || on.ALBUM || on.PANORAMIC) {
        trows.push(["Printed composites and albums", V(d, "TA_COMPOSITE", 4)]);
      }
      if (on.ID_CARD_STUDENT || on.ID_CARD_STAFF) {
        trows.push(["Printed ID cards", V(d, "TA_CARDS", 4)]);
      }
      trows.push(["Family orders shipped, from date of order", V(d, "TA_SHIP", 4)]);
      kvTable(trows, { labelWidth: 330 });

      if (on.RETAKE) {
        sub("Retake day", "One retake day is included at no cost. Any student may retake for any reason, " +
          "including simple dissatisfaction with the first photo. There is no additional charge to a family " +
          "that has already purchased.");
      }

      sub("Satisfaction guarantee", "If a family is unhappy with an order for any reason, they may return it " +
        "for a full refund. The School is never asked to mediate.");

      sub("One point of contact", "The School will have a named contact at 207 Photo for the full school year.");

      sub("No cost and no cash handling", "Every service in this Agreement is provided at no cost to the School " +
        "unless stated otherwise. Families order online. School staff never collect money, hand out order " +
        "envelopes, or chase paperwork.");

      let insTxt = "207 Photo carries commercial general liability coverage of not less than $" +
        V(d, "INS_OCC", 10) + " per occurrence and $" + V(d, "INS_AGG", 10) + " in the aggregate.";
      if (on.INS_SAM) {
        insTxt += " We also carry abuse and molestation liability coverage of not less than $" +
          V(d, "INS_SAM_AMT", 10) + " per occurrence.";
      }
      insTxt += " A current certificate of insurance naming the School as an additional insured is available on request.";
      sub("Insurance", insTxt);

      sub("Background checks", "Every individual 207 Photo sends onto School property holds a current Maine " +
        "Department of Education Criminal History Record Check approval under 20-A M.R.S. section 6103, or is " +
        "accompanied at all times by someone who does. Names and approval expiration dates are available on " +
        "request. This requirement applies equally to any subcontractor or second photographer 207 Photo engages.");

      /* ---------- 4. WHAT THE SCHOOL COMMITS TO ---------- */
      section("What the School Commits To");
      para("The items in this section are requirements. Picture day depends on them.");

      sub("Roster data, due 14 calendar days before picture day at the latest",
        "The School will send a complete student and staff roster in CSV or Excel format to " +
        V(d, "ROSTER_EMAIL", 20) + " no later than 14 calendar days before picture day.");
      para("Student fields required: last name, first name, grade, homeroom or primary teacher, student ID if used.", { before: 2 });
      para("Staff fields required: last name, first name, position or department, building, school email.", { before: 2 });
      para("Accuracy. The School is responsible for the accuracy of the data it sends. 207 Photo is not " +
        "responsible for misspellings, missing students, incorrect grade or homeroom assignments, duplicate " +
        "records, or missing contact information that originate in School supplied data. Correction work " +
        "required as a result may be billed at $" + V(d, "FIX_RATE", 5) + " per hour or reflected in a revised " +
        "delivery schedule, at 207 Photo discretion.", { before: 6 });
      para("Late data. If complete roster data arrives fewer than 14 calendar days before picture day, every " +
        "turnaround commitment above extends day for day, and 207 Photo may reschedule the picture day " +
        "without penalty. Roster changes after the deadline should be sent as a separate file marked as an update.", { before: 6 });

      const comms = [];
      if (on.COMM_ANNOUNCE) comms.push(["Announcement email to all parents and guardians, using the 207 Photo template", "10 or more days before picture day"]);
      if (on.COMM_FLYER) comms.push(["Flyer or graphic posted to the School website, social media, or both", "10 or more days before picture day"]);
      if (on.COMM_REMINDER) comms.push(["Reminder email, app notification or text to all parents and guardians", "1 to 3 days before picture day"]);
      if (on.COMM_GALLERY) comms.push(["Gallery is live email to all parents and guardians, using the 207 Photo template", "Within 3 days of galleries going live"]);
      if (on.COMM_NEWS) comms.push(["Inclusion in the School newsletter, parent portal or district app", "As scheduled"]);
      if (on.COMM_OTHER && d.val.COMM_OTHER) comms.push([d.val.COMM_OTHER, line(14)]);

      if (comms.length) {
        sub("Parent communication", "Families need advance notice to be ready on picture day and to order " +
          "afterward. The School agrees to send every communication listed below, using the templates, flyers " +
          "and graphics 207 Photo provides. We write them. The School sends them.");
        kvTable([["Communication", "When"]].concat(comms), { boldValue: false, labelWidth: 330 });
        para("If the School cannot send a required communication, it will tell 207 Photo in advance so we can " +
          "adjust. Repeatedly failing to send parent communications is grounds for non renewal.", { before: 6 });
      }

      sub("Picture day logistics", "At no cost to 207 Photo, the School will provide:");
      bullet("An indoor space with controllable lighting, approximately " + V(d, "SPACE_SIZE", 14) + ", with working electrical outlets.");
      bullet("Building access beginning " + V(d, "SETUP_MIN", 4) + " minutes before scheduled start time for setup, and " +
        V(d, "BREAKDOWN", 4) + " minutes after the last session for breakdown.");
      bullet("A designated staff liaison present for the length of the session.");
      bullet("A class flow schedule and bell schedule, provided at least 5 days in advance.");
      bullet("Staff supervision of students while they are in the photography area.");
      bullet("Reasonable parking and a route for unloading equipment.");

      sub("Student privacy confirmations", "Before the first picture day of each school year, the School will " +
        "confirm in writing that:");
      bullet("It has designated 207 Photo as a school official with a legitimate educational interest under FERPA, " +
        "34 CFR section 99.31(a)(1)(i)(B), for the purpose of providing photography services, or it has " +
        "properly designated student photographs and directory information under 34 CFR section 99.37 with " +
        "the required annual notice to families.");
      bullet("It has given 207 Photo a current directory information opt out list naming any student whose image " +
        "or information may not be released, published in a gallery, or included in group photography.");
      para("The School is responsible for keeping that opt out list current. 207 Photo will honor every name on " +
        "the list it receives.", { before: 4 });

      /* ---------- 5. STUDENT DATA ---------- */
      section("Student Data");

      sub("Limited purpose", "We use roster data only to run the School picture day, deliver School files, and " +
        "let families know their photos are ready. We do not sell student data, use it for targeted advertising, " +
        "or build profiles of students. This is consistent with the Maine Student Information Privacy Act, " +
        "20-A M.R.S. sections 951 through 953.");

      sub("Security", "We keep administrative, technical and physical safeguards appropriate to the nature of the " +
        "data. Roster data is held in access controlled systems and shared only with service providers who are " +
        "contractually bound to equivalent restrictions.");

      sub("Service providers", "Our ordering and gallery platform is GotPhoto, operated by fotograf.de. Our print " +
        "fulfillment lab is Alkit Pro Lab. Both are bound by confidentiality obligations. We will tell the School " +
        "if either provider changes.");

      sub("Galleries", "Family galleries are access controlled. A family reaches only its own student images, " +
        "using a unique access code.");

      sub("Deletion", "We will delete roster data containing student personally identifiable information within " +
        "45 days of a written request from the School, and in any case within 45 days after the end of the " +
        "school year in which it was collected. A written certificate of destruction is available on request.");

      sub("Photographs are a separate category", "The photographs themselves are 207 Photo copyrighted works. " +
        "We keep them so families can reorder later. Once the ordering period closes, images are stored without " +
        "linked roster data. Deleting roster data does not require deleting the photographs.");

      sub("Security incidents", "If we confirm a security incident affecting School data, we will notify the " +
        "School primary contact within 72 hours and cooperate with the School in meeting any obligation under " +
        "10 M.R.S. section 1348.");

      sub("Communications with families", "The School agrees that 207 Photo will contact parents and guardians " +
        "by email and text about that School picture day. That includes advance notice, gallery availability, " +
        "order status, shipping, ordering deadlines, retake day, and reorder windows. These messages are part " +
        "of delivering the service and are expressly permitted under this Agreement. Every message carries a " +
        "one click unsubscribe. 207 Photo will not use School supplied contact information to market unrelated " +
        "products or services without the School written consent.");

      /* ---------- 6. COPYRIGHT ---------- */
      section("Photographs and Copyright");

      sub("Ownership", "207 Photo holds the copyright in every image it creates, under Title 17 of the United " +
        "States Code. This is a service and license agreement. It is not a work for hire agreement and it does " +
        "not transfer copyright.");

      sub("The School license", "207 Photo grants the School a perpetual, royalty free, non exclusive, non " +
        "transferable license to use the images delivered under this Agreement for School purposes, meaning:");
      bullet("Yearbook, newsletters and School publications.", { bold: true });
      bullet("Student and staff ID cards and badges.", { bold: true });
      bullet("The student information system and administrative records.", { bold: true });
      bullet("The School website, School social media accounts and School app.", { bold: true });
      bullet("Bulletin boards, hallway displays and awards.", { bold: true });
      bullet("Enrollment, recruitment and community materials for the School.", { bold: true });

      sub("Limits on the license", "Without written permission the School may not sell or license images to a " +
        "third party, give high resolution files to another vendor or photographer for reuse, enter images in " +
        "contests, alter or filter images or remove a watermark or credit, use images in paid advertising for a " +
        "third party, or claim authorship. Reasonable cropping for layout is fine.");

      sub("No AI training", "Images provided under this Agreement may not be used to train, fine tune or develop " +
        "any artificial intelligence or machine learning model, and may not be given to a third party for that " +
        "purpose.");

      sub("Credit", "Where it is practical, School social media posts that use 207 Photo images should carry a " +
        "visible credit: Photo by @207Photo, or Photo credit: 207 Photo, 207photo.com.");

      sub("How 207 Photo uses images", "207 Photo may use general picture day images in its portfolio and " +
        "marketing, meaning setup shots, room and environment photos, and images in which no student is " +
        "identifiable. We will not use an identifiable student portrait in our own marketing without written " +
        "parent or guardian consent, and never for a student on the opt out list.");

      /* ---------- 7. PRICING ---------- */
      section("Pricing and Family Ordering");

      sub("No cost to the School", "Every service in this Agreement is provided at no cost to the School. " +
        "207 Photo is paid through voluntary family purchases.");

      if (on.PRICELIST) {
        sub("Price list", "The current family price list is attached and forms part of this Agreement. 207 Photo " +
          "may update its price list once per school year and will give the School the updated list at least 30 " +
          "days before the first picture day it affects.");
      }

      sub("Promotions", "207 Photo runs its own promotional calendar for families, which may include free " +
        "shipping windows, early order incentives and gallery closing dates. None of this affects the School.");

      sub("Sales tax", "Prices do not include Maine sales tax, which is applied to family purchases at the " +
        "applicable rate. Purchases made directly by the School are exempt once 207 Photo has a current Maine " +
        "exemption certificate on file.");

      if (on.SCHOOL_BUYS) {
        sub("School purchases", "Items the School orders directly, such as banners, additional ID cards, framed " +
          "composites or extra albums, are invoiced at the rates 207 Photo provides in writing, net " +
          V(d, "NET_DAYS", 4) + " days." +
          (d.val.PO_NUMBER ? " Purchase order number: " + d.val.PO_NUMBER + "." : ""));
      }

      sub("Family support", "207 Photo handles all family billing, refunds, reprints and support directly. " +
        "The School is never asked to handle money or resolve an order problem.");

      /* ---------- 8. REBATE (conditional) ---------- */
      if (on.REBATE_PCT || on.REBATE_FLAT || on.FRL) {
        section("Fundraising and Rebate");

        if (on.REBATE_PCT || on.REBATE_FLAT) {
          let rTxt = "The School will receive a rebate of ";
          if (on.REBATE_PCT) rTxt += V(d, "REBATE_PCT", 4) + " percent of net sales";
          if (on.REBATE_PCT && on.REBATE_FLAT) rTxt += ", plus ";
          if (on.REBATE_FLAT) rTxt += "$" + V(d, "REBATE_FLAT", 4) + " per completed order";
          rTxt += ".";
          sub("Rebate", rTxt);
          para("Net sales means gross family purchase revenue attributable to this School, less sales tax, " +
            "shipping, payment processing fees, discounts, scholarships and refunds. The rebate is calculated " +
            "when the ordering period closes and paid within 30 days by check to the School" +
            (d.val.REBATE_DEST ? ", designated for " + d.val.REBATE_DEST : "") + ".", { before: 4 });
        }

        if (on.FRL) {
          sub("Families with financial need", "207 Photo will provide a complimentary " +
            V(d, "FRL", 14) + " package to families the School identifies as eligible, up to " +
            V(d, "FRL_QTY", 4) + " students per school year. The School identifies eligible families. " +
            "207 Photo never sees the eligibility list and never learns which students qualified.");
        }
      }

      /* ---------- 9. EXCLUSIVITY (conditional) ---------- */
      if (on.EXCLUSIVITY) {
        section("Exclusivity");
        para("For the term of this Agreement, 207 Photo is the exclusive provider of the photography services " +
          "described in this Agreement, at the buildings listed above. The School will not engage another " +
          "vendor to provide those services during the term.");
        para("This does not restrict:", { before: 6 });
        bullet("Photography services in categories this Agreement does not cover.");
        bullet("Photographs taken by School staff, students, families or the yearbook staff for School use.");
        bullet("Media, press or event photography the School did not arrange.");
        bullet("Senior portraits arranged privately by individual families with a photographer of their choosing.");
        para("207 Photo remains free to provide services to other schools, leagues and clients.", { before: 4 });
      }

      /* ---------- 10. SCHEDULING ---------- */
      section("Scheduling, Weather and Cancellation");

      sub("Rescheduling by the School", "Picture day dates are held exclusively for the School. If the School " +
        "reschedules with more than 14 days notice, 207 Photo will find a new date at no charge, subject to " +
        "availability. With 14 days notice or less, a rescheduling fee of $" + V(d, "RESCHED_FEE", 5) + " may apply.");

      sub("Closures, weather and emergencies", "If the School closes for weather, illness, an emergency, a remote " +
        "learning day, or any other cause outside either party control, no fee applies. Both parties will work " +
        "promptly to set a new date, and turnaround commitments shift accordingly.");

      sub("Rescheduling by 207 Photo", "If 207 Photo must reschedule for a reason within its control, we will " +
        "give as much notice as possible and offer the earliest available alternative date.");

      sub("Events outside either party control", "Neither party is liable for failing to perform because of fire, " +
        "flood, storm, natural disaster, epidemic, public health order, act of war or terrorism, labor action, " +
        "or a utility or transportation failure. Affected obligations are suspended for as long as the event lasts.");

      /* ---------- 11. GENERAL ---------- */
      section("General Terms");

      sub("Independent contractor", "207 Photo is an independent contractor, not an employee or agent of the School.");

      sub("Conduct on School property", "207 Photo personnel will act professionally, stay in designated work " +
        "areas, follow School visitor and safety policies, and sign in as required. The School may ask that any " +
        "individual be removed from its premises. 207 Photo will substitute qualified personnel promptly, and " +
        "doing so is not a breach of this Agreement.");

      sub("Compliance with law", "Each party will comply with applicable federal, state and local law, including " +
        "FERPA and Maine student privacy and background check requirements. 207 Photo does not discriminate on " +
        "the basis of race, color, religion, sex, national origin, age, disability, sexual orientation, gender " +
        "identity, or any other protected status.");

      sub("Indemnification", "Each party will indemnify, defend and hold the other harmless from third party " +
        "claims arising from its own negligence or willful misconduct in connection with this Agreement. " +
        "Neither party owes that duty to the extent a claim arises from the other party sole negligence or " +
        "willful misconduct.");

      sub("Limitation of liability", "Neither party is liable for indirect, incidental, consequential, special or " +
        "punitive damages. Total liability of 207 Photo under this Agreement is limited to the greater of $" +
        V(d, "LIAB_CAP", 8) + " or the total amount 207 Photo received from family purchases attributable to " +
        "the School in the twelve months before the claim. This limit does not apply to the indemnification " +
        "obligations above or to a breach of the Student Data section.");

      sub("Assignment", "Neither party may assign this Agreement without the written consent of the other, which " +
        "will not be unreasonably withheld. 207 Photo may assign it to a successor in connection with a sale or " +
        "reorganization of the business, on written notice.");

      sub("Notices", "Notices must be in writing, sent by email with confirmation of receipt or by mail, to the " +
        "contacts named in this Agreement.");

      sub("Governing law", "Maine law governs this Agreement. Venue for any dispute lies in the courts of " +
        V(d, "COUNTY", 10) + " County, Maine. Before filing suit the parties will try in good faith to resolve " +
        "the dispute through direct discussion between the people named in this Agreement, and then through " +
        "mediation.");

      sub("Entire agreement", "This Agreement, together with " +
        (on.PRICELIST ? "the attached price list and " : "") +
        "any signed addendum, is " +
        "the entire agreement between the parties and replaces any earlier proposal or understanding. Changes " +
        "must be in writing and signed by both parties. If the School asks 207 Photo to sign a district standard " +
        "vendor agreement, purchase order terms, or a student data privacy agreement, and those terms conflict " +
        "with this Agreement, this Agreement controls unless both parties agree otherwise in a signed writing.");

      sub("Severability", "If any provision is held unenforceable, the rest of the Agreement stays in effect.");

      sub("Survival", "The Student Data section, the Photographs and Copyright section, indemnification, " +
        "limitation of liability and governing law survive expiration or termination.");

      /* ---------- 12. TERM ---------- */
      section("Term, Renewal and Termination");

      sub("Initial term", "This Agreement begins on " + V(d, "START_DATE", 16) + " and runs through June 30, " +
        V(d, "END_YEAR", 6) + ", covering " + yearsPhrase(d.val.TERM_YEARS) + ".");

      if (on.AUTORENEW) {
        sub("Automatic renewal", "This Agreement renews automatically for successive one year terms unless either " +
          "party gives written notice of non renewal at least 90 days before the end of the current term. At the " +
          "start of each renewal year the services are reviewed and confirmed. If the School does not ask for " +
          "changes, the prior year services carry forward.");
      }

      sub("Termination for convenience", "Either party may terminate on 60 days written notice. A termination " +
        "that takes effect within 30 days of a scheduled picture day does not release the School from its " +
        "obligations for a session already underway.");

      sub("Termination for cause", "Either party may terminate for a material breach that is still uncured 30 " +
        "days after written notice describing it.");

      sub("What happens on termination", "207 Photo will finish delivering files for sessions already " +
        "photographed, honor family orders already placed, and delete roster data on the schedule described in " +
        "the Student Data section. The School license to images already delivered survives termination.");

      /* ---------- 13. SIGNATURES ---------- */
      section("Signatures");
      para("By signing below, each party confirms it has read this Agreement, has authority to bind its " +
        "organization, and agrees to its terms.");

      para("SCHOOL OR SCHOOL ADMINISTRATIVE UNIT", { cls: ["ab-sighead"] });
      kvTable([
        ["Organization", d.val.SCHOOL_NAME || line(30)],
        ["Signature", " "],
        ["Title", " "],
        ["Date", " "],
        ["Email and phone", V(d, "CONTACT_EMAIL", 20) + ",  " + V(d, "CONTACT_PHONE", 14)],
        ["Billing address", V(d, "BILLING_ADDR", 30)],
      ]);

      para("207 PHOTO & DESIGN", { cls: ["ab-sighead"] });
      kvTable([
        ["Signature", " "],
        ["Printed name", STUDIO.signer],
        ["Title", STUDIO.title],
        ["Date", " "],
        ["Email and phone", STUDIO.email + ",  " + STUDIO.phone],
      ]);

      /* ---------- PRICE LIST ---------- */
      if (on.PRICELIST) {
        pageBreak();
        para("FAMILY PRICE LIST", { tag: "h2", cls: ["ab-pagehead"] });
        para("This page forms part of the School Photography Service Agreement between 207 Photo & Design and " +
          (d.val.SCHOOL_NAME || line(24)) + " for the " + yrs + " school year.");
        para("Attach or paste the current 207 Photo school price list here.", { cls: ["ab-note"] });
      }

      /* ---------- WORKSHEET ---------- */
      if (on.WORKSHEET) {
        pageBreak();
        para("KEY DATES WORKSHEET", { tag: "h2", cls: ["ab-pagehead"] });
        para("A shared checklist for the year. This page is a working reference and does not change the terms above.");

        const w = [["Milestone", "Date", "Who"]];
        w.push(["Agreement signed", V(d, "START_DATE", 12), "Both"]);
        w.push(["Roster data sent to 207 Photo", line(12), "School"]);
        w.push(["Flyer and templates sent to the School", line(12), "207 Photo"]);
        if (on.COMM_ANNOUNCE) w.push(["Announcement email to parents", line(12), "School"]);
        if (on.COMM_FLYER) w.push(["Flyer live on website or social media", line(12), "School"]);
        if (on.COMM_REMINDER) w.push(["Reminder to parents", line(12), "School"]);
        if (on.FALL) w.push(["Fall picture day", V(d, "FALL", 12), "Both"]);
        if (on.SPRING) w.push(["Spring picture day", V(d, "SPRING", 12), "Both"]);
        w.push(["Galleries live", line(12), "207 Photo"]);
        if (on.COMM_GALLERY) w.push(["Gallery is live email to parents", line(12), "School"]);
        if (on.YEARBOOK || on.SIS || on.STAFF_BADGE || on.STUDENT_BADGE) {
          w.push(["Yearbook, SIS and ID files delivered", line(12), "207 Photo"]);
        }
        if (on.RETAKE) w.push(["Retake day", V(d, "RETAKE", 12), "Both"]);
        if (on.CLASS_PRINT || on.ALBUM) w.push(["Composites and albums delivered", line(12), "207 Photo"]);
        w.push(["Ordering closes", line(12), "207 Photo"]);
        w.push(["Next year check in", line(12), "Both"]);
        out('<table class="ab-table ab-ws"><tbody>' + w.map((r, wr) => "<tr>" + r.map((c, wc) =>
          "<td" + (wr === 0 || wc === 0 ? ' class="ab-b"' : "") + ">" + txt(c) + "</td>").join("") + "</tr>").join("") + "</tbody></table>",
          w.map((r) => r.join("  |  ")).join("\n"));
      }

      /* ---------- FOOTER ---------- */
      const foot = STUDIO.name + "  |  " + STUDIO.site + "  |  Picture Day, Done Right";
      out('<p class="ab-p ab-foot">' + txt(foot) + "</p>", "\n" + foot);
      endList();

      return { html: '<div class="ab-doc-in">' + H.join("") + "</div>", text: T.join("\n\n").replace(/\n{3,}/g, "\n\n").trim() + "\n" };
    }

    // Name of the doc the script made: "<School> - School Photography Service Agreement <start>-<end>".
    function docTitle(input) {
      const d = normalize(input);
      return "School Photography Service Agreement " + (d.val.YEAR_START || "") + "-" + (d.val.YEAR_END || "");
    }

    // ---------------------------------------------------------------- showing stored markup safely
    // Only the markup renderAgreement makes: these tags, and class names that start with ab-. Everything else is
    // dropped (its text kept); no other attributes survive. Used on the public page and in previews.
    const OK_TAGS = ["DIV", "P", "H1", "H2", "TABLE", "TBODY", "TR", "TD", "UL", "LI", "B", "HR", "BR", "SPAN"];
    function sanitize(html) {
      if (typeof document === "undefined") return "";
      const tpl = document.createElement("template");
      tpl.innerHTML = String(html || "");
      const walk = (node) => {
        Array.from(node.childNodes).forEach((n) => {
          if (n.nodeType === 3) return;
          if (n.nodeType !== 1) { n.remove(); return; }
          if (OK_TAGS.indexOf(n.tagName) < 0) {
            if (["SCRIPT", "STYLE", "IFRAME", "OBJECT", "EMBED", "TEMPLATE", "SVG", "MATH", "NOSCRIPT"].indexOf(n.tagName.toUpperCase()) >= 0) { n.remove(); return; }
            walk(n);
            n.replaceWith.apply(n, Array.from(n.childNodes));
            return;
          }
          Array.from(n.attributes).forEach((a) => {
            if (a.name === "class") {
              const keep = a.value.split(/\s+/).filter((c) => /^ab-[a-z0-9-]+$/.test(c)).join(" ");
              if (keep) n.setAttribute("class", keep); else n.removeAttribute("class");
            } else n.removeAttribute(a.name);
          });
          walk(n);
        });
      };
      walk(tpl.content);
      return tpl.innerHTML;
    }

    // The look of the document (orange #E16239 headings, charcoal #252720 text), added once to the page.
    const CSS = `
  .aca .ab-doc { white-space: normal; color: ${BRAND.charcoal}; font-size: 14px; line-height: 1.45; background: #fff; }
  .aca .ab-doc .ab-p { margin: 6px 0; }
  .aca .ab-doc .ab-tight { margin-top: 2px; }
  .aca .ab-doc .ab-b { font-weight: 700; }
  .aca .ab-doc h1.ab-title { font-size: 21px; font-weight: 700; margin: 0 0 2px; color: ${BRAND.charcoal}; line-height: 1.2; }
  .aca .ab-doc .ab-studio { font-size: 12px; color: #666; margin: 0; }
  .aca .ab-doc .ab-tag { font-size: 13px; color: ${BRAND.orange}; font-weight: 700; margin: 4px 0 10px; }
  .aca .ab-doc .ab-hr { border: 0; border-top: 1px solid ${BRAND.rule}; margin: 10px 0; }
  .aca .ab-doc h2.ab-sec { color: ${BRAND.orange}; font-size: 15px; font-weight: 700; margin: 20px 0 6px; letter-spacing: 0; text-transform: none; }
  .aca .ab-doc .ab-sub { margin: 8px 0 6px; }
  .aca .ab-doc .ab-ul { margin: 2px 0 6px; padding-left: 22px; }
  .aca .ab-doc .ab-ul li { margin: 2px 0; }
  .aca .ab-doc .ab-table { border-collapse: collapse; width: 100%; margin: 8px 0; font-size: 13px; table-layout: fixed; }
  .aca .ab-doc .ab-table td, .aca .ab-doc .ab-table tr:hover td, .aca .ab-doc .ab-table tr:last-child td { border: 1px solid ${BRAND.rule}; padding: 4px 7px; text-align: center; vertical-align: middle; overflow-wrap: anywhere; background: #fff; color: ${BRAND.charcoal}; height: auto; }
  .aca .ab-doc .ab-w190 td:first-child { width: 36%; }
  .aca .ab-doc .ab-w330 td:first-child { width: 64%; }
  .aca .ab-doc .ab-ws td:first-child { width: 57%; }
  .aca .ab-doc .ab-ws td:nth-child(2) { width: 27%; }
  .aca .ab-doc .ab-sighead { color: ${BRAND.orange}; font-weight: 700; font-size: 13px; margin: 16px 0 4px; }
  .aca .ab-doc h2.ab-pagehead { font-size: 18px; font-weight: 700; color: ${BRAND.charcoal}; margin: 0 0 4px; }
  .aca .ab-doc .ab-note { color: #888; margin-top: 10px; }
  .aca .ab-doc .ab-break { border-top: 2px dashed ${BRAND.rule}; margin: 26px 0 18px; }
  .aca .ab-doc .ab-foot { font-size: 11px; color: #999; text-align: center; margin-top: 22px; }
  @media print { .aca .ab-doc .ab-break { border: 0; margin: 0; page-break-before: always; break-before: page; } .aca .ab-doc .ab-table td { padding: 3px 6px; } }
`;
    let cssDone = false;
    function ensureCss(extra) {
      if (cssDone || typeof document === "undefined") return;
      cssDone = true;
      const st = document.createElement("style"); st.textContent = CSS + (extra || ""); document.head.appendChild(st);
    }

    return { BRAND, STUDIO, SPEC, DATE_KEYS, MONEY_KEYS, DEFAULT_ON, KEEP, STANDARD_KEYS, DELIVERABLES,
      specDefaults, commas, normalize, isoOf, line, yearsPhrase, renderAgreement, docTitle, sanitize, ensureCss };
  })();
  const renderAgreement = AgreementDoc.renderAgreement;

  // ================================================================ the builder dialog
  // AgreementBuilder.open(orgId, opts): opts.id = an existing builder agreement; opts.copyFrom = start a new one
  // from another agreement's choices (next year's); opts.onDone() after a save or send.
  const AgreementBuilder = (function () {
    if (typeof document === "undefined") return { open() {} };
    const sb = () => supabase;
    const D = AgreementDoc;
    const cleanErr = (e) => String((e && (e.message || e.details)) || e || "Something went wrong").replace(/^P0001:\s*/, "");
    const CSS = `
  .aca .modal.ab-modal { max-width: 1240px; padding: 16px 18px; }
  .aca .ab-wrap { display: grid; grid-template-columns: minmax(0, 470px) minmax(0, 1fr); gap: 18px; align-items: start; }
  .aca .ab-form { max-height: 72vh; overflow: auto; padding-right: 6px; }
  .aca .ab-prev { max-height: 72vh; overflow: auto; border: 1px solid var(--line2); border-radius: 4px; background: #fff; padding: 22px 26px; }
  .aca .ab-shead { background: #252720; color: #fff; font-weight: 600; font-size: 12.5px; letter-spacing: .02em; padding: 5px 9px; border-radius: 3px; margin: 16px 0 6px; }
  .aca .ab-row { display: grid; grid-template-columns: 26px minmax(0, 1fr) minmax(0, 170px); gap: 4px 8px; align-items: center; padding: 3px 0; border-bottom: 1px solid var(--line2); font-size: 13.5px; }
  .aca .ab-row.ab-field { grid-template-columns: minmax(0, 1fr) minmax(0, 200px); }
  .aca .ab-row.ab-ind > span { padding-left: 22px; color: var(--muted); }
  .aca .ab-row input[type=text], .aca .ab-row input[type=date], .aca .ab-row select { width: 100%; height: 30px; font-size: 13px; background: #FFF9EE; }
  .aca .ab-row input[type=checkbox] { width: 16px; height: 16px; margin: 0 auto; }
  .aca .ab-row label { cursor: pointer; }
  .aca .ab-noteline { font-size: 12.5px; color: var(--muted); margin: 0 0 8px; line-height: 18px; }
  .aca .ab-std { margin: 14px 0 4px; border: 1px solid var(--line2); border-radius: 4px; padding: 6px 10px; }
  .aca .ab-std summary { cursor: pointer; font-weight: 600; font-size: 13.5px; padding: 4px 0; }
  .aca .ab-std .ab-stdsum { font-size: 12.5px; color: var(--muted); font-weight: 400; display: block; }
  .aca .ab-apply { display: flex; gap: 8px; align-items: flex-start; font-size: 13px; line-height: 18px; margin: 12px 0 0; }
  .aca .ab-apply input { margin-top: 2px; }
  .aca .ab-pick { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin: 0 0 10px; font-size: 13px; }
  .aca .ab-pick select { max-width: 100%; }
  .aca .ab-st { font-size: 12.5px; color: var(--muted); }
  @media (max-width: 900px) {
    .aca .ab-wrap { grid-template-columns: 1fr; }
    .aca .ab-form, .aca .ab-prev { max-height: none; overflow: visible; }
    .aca .ab-prev { padding: 14px 12px; }
    .aca .modal.ab-modal { padding: 14px 12px; }
  }
  @media (max-width: 520px) {
    .aca .ab-row { grid-template-columns: 26px minmax(0, 1fr); }
    .aca .ab-row > input[type=text], .aca .ab-row > input[type=date] { grid-column: 2; }
    .aca .ab-row.ab-field { grid-template-columns: 1fr; }
  }
`;
    // Boxes that the agreement reads, with a hint of what goes in them (the sheet's column C).
    const DETAIL = {
      FALL: "date", SPRING: "date", RETAKE: "date", GRAD: "date", SENIOR: "date",
      ADDL: "Description", CLUBS: "Details (optional)", ATHLETICS: "Which sports (optional)", ID_CARD_STUDENT: "Quantity (optional)",
      ID_CARD_STAFF: "Quantity (optional)", SIS: "Which SIS (optional)", YEARBOOK: "Yearbook company (optional)", CLASS_PRINT: "Quantity (optional)",
      STICKERS: "How many per student (optional)", ALBUM: "Quantity (optional)", EVENT: "Describe it", OTHER: "Describe it",
      REBATE_PCT: "Percent", REBATE_FLAT: "Dollars per order", FRL: "Package name", COMM_OTHER: "Describe it",
    };
    const DATE_FIELDS = ["START_DATE"];
    const STD_HEADS = ["OUR COMMITMENTS (defaults are fine for most schools)", "PROTECTIVE TERMS", "PICTURE DAY LOGISTICS"];
    const TZ = "America/New_York";
    const todayStr = () => new Date().toLocaleDateString("en-CA", { timeZone: TZ });
    const longDay = (iso) => (iso ? new Date(String(iso).slice(0, 10) + "T12:00:00").toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" }) : "");
    const schoolYearOf = (iso) => { const y = +String(iso).slice(0, 4), m = +String(iso).slice(5, 7); return m >= 7 ? y : y - 1; };

    // ---------------------------------------------------------------- starting values
    // Saved choices, or the sheet's defaults + our standard terms + what the app already knows about the partner.
    function startingInputs(ctx, base) {
      if (base) return { on: Object.assign({}, base.on || {}), val: Object.assign({}, base.val || {}) };
      const d = D.specDefaults();
      const std = ctx.defaults || {};
      D.STANDARD_KEYS.forEach((k) => { if (std[k] !== undefined && std[k] !== null && String(std[k]) !== "") d.val[k] = String(std[k]); });
      const o = ctx.org || {};
      d.val.SCHOOL_NAME = o.legal_name || o.name || "";
      const prev = (ctx.last && ctx.last.val) || {};
      if (o.billing_address || prev.BILLING_ADDR) d.val.BILLING_ADDR = o.billing_address || prev.BILLING_ADDR;
      if (prev.BUILDINGS) d.val.BUILDINGS = prev.BUILDINGS;
      fillContact(d, (ctx.contacts || [])[0]);
      fillDates(d, ctx);
      return d;
    }
    function fillContact(d, c) {
      if (!c) return;
      d.val.CONTACT_NAME = c.name || ""; d.val.CONTACT_TITLE = c.role || ""; d.val.CONTACT_EMAIL = c.email || ""; d.val.CONTACT_PHONE = c.phone || "";
    }
    // Fall picture day + retake day from this partner's school jobs; the school year from those dates (or today).
    function fillDates(d, ctx) {
      const today = todayStr();
      const jobs = (ctx.bookings || []).filter((b) => b.picture_day && b.status !== "cancelled" && b.audience !== "sports");
      const upcoming = jobs.filter((b) => b.picture_day >= today).sort((a, b) => (a.picture_day < b.picture_day ? -1 : 1));
      let ys = schoolYearOf(today);
      const anchor = upcoming[0] || jobs.filter((b) => schoolYearOf(b.picture_day) === ys).sort((a, b) => (a.picture_day < b.picture_day ? -1 : 1))[0];
      if (anchor) ys = schoolYearOf(anchor.picture_day);
      const inYear = jobs.filter((b) => schoolYearOf(b.picture_day) === ys).sort((a, b) => (a.picture_day < b.picture_day ? -1 : 1));
      const fall = inYear.find((b) => +b.picture_day.slice(5, 7) >= 7) || null;
      const spring = inYear.find((b) => +b.picture_day.slice(5, 7) < 7 && b !== fall) || null;
      if (fall) { d.val.FALL = fall.picture_day; if (fall.retake_day) d.val.RETAKE = String(fall.retake_day).slice(0, 10); }
      if (spring) { d.val.SPRING = spring.picture_day; d.on.SPRING = true; if (!d.val.RETAKE && spring.retake_day) d.val.RETAKE = String(spring.retake_day).slice(0, 10); }
      d.val.YEAR_START = String(ys); d.val.YEAR_END = String(ys + 1);
      const term = parseInt(d.val.TERM_YEARS, 10) || 1;
      d.val.END_YEAR = String(ys + term);
      d.val.START_DATE = ys + "-09-01";
      d.booking_id = (fall || spring || anchor || {}).id || null;
    }
    // The jobs "Apply" touches: this partner's school jobs in the agreement's school year (not cancelled or done).
    function jobsToApply(ctx, inp) {
      const ys = parseInt(inp.val.YEAR_START, 10), ye = parseInt(inp.val.YEAR_END, 10);
      return (ctx.bookings || []).filter((b) => b.audience === "school" && (b.status === "booked" || b.status === "tracked") && b.picture_day &&
        (ys && ye ? b.picture_day >= ys + "-07-01" && b.picture_day <= ye + "-06-30" : b.picture_day >= todayStr()));
    }
    const deliverablesOf = (inp) => Object.keys(D.DELIVERABLES).filter((k) => inp.on[k]).map((k) => D.DELIVERABLES[k]);

    // ---------------------------------------------------------------- the form
    function rowHtml(s, inp, ro) {
      const dis = ro ? " disabled" : "";
      const id = "ab_" + s.key;
      const label = s.label.replace(/^\s+/, "");
      const ind = /^\s/.test(s.label);
      const v = inp.val[s.key] || "";
      if (s.t === "service") {
        const det = DETAIL[s.key];
        const box = !det ? "<span></span>" : det === "date"
          ? '<input type="date" data-val="' + s.key + '" value="' + esc(D.isoOf(v) || "") + '" aria-label="' + esc(label) + ' date"' + dis + " />"
          : '<input type="text" data-val="' + s.key + '" value="' + esc(v) + '" placeholder="' + esc(det) + '" aria-label="' + esc(label) + ' detail"' + dis + " />";
        return '<div class="ab-row"><input type="checkbox" id="aca-' + id + '" data-on="' + s.key + '"' + (inp.on[s.key] ? " checked" : "") + dis + ' /><label for="aca-' + id + '">' + esc(label) + "</label>" + box + "</div>";
      }
      const type = DATE_FIELDS.indexOf(s.key) >= 0 ? "date" : "text";
      const val = type === "date" ? (D.isoOf(v) || "") : v;
      return '<div class="ab-row ab-field' + (ind ? " ab-ind" : "") + '"><span><label for="aca-' + id + '">' + esc(label) + "</label></span>" +
        '<input type="' + type + '" id="aca-' + id + '" data-val="' + s.key + '" value="' + esc(val) + '"' + dis + " /></div>";
    }
    function formHtml(inp, ro) {
      let h = "", inStd = false, group = "";
      D.SPEC.forEach((s) => {
        if (s.t === "title") return;
        if (s.t === "note") { h += '<p class="ab-noteline">' + esc(s.label) + "</p>"; return; }
        if (s.t === "head") {
          group = s.label;
          const std = STD_HEADS.indexOf(s.label) >= 0;
          if (std && !inStd) { h += '<details class="ab-std" id="aca-abStd"><summary>Our standard terms (change for this school)<span class="ab-stdsum" id="aca-abStdSum"></span></summary>'; inStd = true; }
          if (!std && inStd) { h += (ro ? "" : '<p class="ab-noteline" style="margin-top:8px"><button type="button" class="link" id="aca-abStdSave">Make these our standard terms for every school</button></p>') + "</details>"; inStd = false; }
          h += '<div class="ab-shead">' + esc(s.label) + "</div>";
          return;
        }
        h += rowHtml(s, inp, ro);
      });
      if (inStd) h += "</details>";
      return h;
    }
    function readForm(m, inp) {
      m.querySelectorAll("[data-on]").forEach((n) => { if (n.checked) inp.on[n.dataset.on] = true; else delete inp.on[n.dataset.on]; });
      m.querySelectorAll("[data-val]").forEach((n) => { const v = n.value.trim(); if (v) inp.val[n.dataset.val] = v; else delete inp.val[n.dataset.val]; });
      return inp;
    }

    // ---------------------------------------------------------------- open
    async function open(orgId, opts) {
      opts = opts || {};
      D.ensureCss();
      if (!document.getElementById("aca-abCss")) { const st = document.createElement("style"); st.id = "aca-abCss"; st.textContent = CSS; document.head.appendChild(st); }
      const { data: ctx, error } = await sb().rpc("agreement_builder_context", { p_org: orgId || null, p_id: opts.id || null, p_from: opts.copyFrom || null });
      if (error || !ctx) return toast(cleanErr(error || "Not found."), true);
      const ag = ctx.agreement || null;
      const ro = !canEdit("agreements") || !!(ag && (ag.status === "accepted" || ag.status === "void"));
      let agId = ag ? ag.id : null;
      const inp = startingInputs(ctx, (ag && ag.builder) || (ctx.from && ctx.from.builder) || null);
      let bookingId = (ag && ag.booking_id) || inp.booking_id || null;
      delete inp.booking_id;
      if (ctx.from && ctx.from.builder && !ag) {
        // Next year's from this one: same choices, this year's dates.
        ["FALL", "SPRING", "RETAKE", "GRAD", "SENIOR", "START_DATE"].forEach((k) => { delete inp.val[k]; });
        fillDates(inp, ctx);
        bookingId = inp.booking_id || null;
        delete inp.booking_id;
      }
      const contacts = ctx.contacts || [];
      const org = ctx.org || {};

      const m = openModal('<h2>School agreement: ' + esc(org.name || "") + (ag ? ' <span class="ab-st">' + esc(ag.status === "sent" ? "Sent" : ag.status === "accepted" ? "Accepted" : ag.status === "void" ? "Void" : "Draft") + "</span>" : "") + "</h2>" +
        (contacts.length > 1 && !ro ? '<div class="ab-pick"><label for="aca-abWho">Main contact</label><select id="aca-abWho">' +
          contacts.map((c, i) => '<option value="' + i + '"' + (c.email && c.email === inp.val.CONTACT_EMAIL ? " selected" : "") + ">" + esc(c.name || c.email) + (c.role ? " (" + esc(c.role) + ")" : "") + "</option>").join("") + "</select></div>" : "") +
        (ro && ag && ag.status === "accepted" ? '<p class="ab-noteline">Accepted ' + esc(longDay(ag.accepted_at)) + " by " + esc(ag.accepted_name || "") + ". This is exactly what they accepted; it can&#8217;t change.</p>" : "") +
        '<div class="ab-wrap"><div class="ab-form" id="aca-abForm">' + formHtml(inp, ro) + '</div><div class="ab-prev ab-doc" id="aca-abPrev" aria-label="Preview of the agreement"></div></div>' +
        (ro ? "" : '<label class="ab-apply"><input type="checkbox" id="aca-abApply" checked /> <span id="aca-abApplyTxt"></span></label>') +
        '<div class="inline-error hidden" id="aca-abErr"></div>' +
        '<div class="modal-actions"><button type="button" class="small" id="aca-abCancel">' + (ro ? "Close" : "Cancel") + '</button><span class="grow"></span>' +
          '<button type="button" class="small" id="aca-abView">Preview as the school sees it</button>' +
          (ro ? "" : '<button type="button" id="aca-abSave">Save draft</button><button type="button" class="primary" id="aca-abSend">Send for signature</button>') + "</div>",
        { locked: !ro });
      m.classList.add("ab-modal");
      const err = (t) => { const n = el("abErr"); n.textContent = t; n.classList.toggle("hidden", !t); };
      const frozen = ro && ag && ag.status === "accepted" && ag.accepted_html;

      // Live preview + the standard-terms line + what Apply will do.
      let timer = null;
      const refresh = () => {
        readForm(m, inp);
        el("abPrev").innerHTML = frozen ? D.sanitize(ag.accepted_html) : D.sanitize(D.renderAgreement(inp).html);
        const std = ctx.defaults || {};
        const norm = (x) => String(x === undefined || x === null ? "" : x).replace(/,/g, "").trim();
        const changed = D.STANDARD_KEYS.filter((k) => std[k] !== undefined && norm(inp.val[k]) !== norm(std[k]));
        const sum = el("abStdSum");
        if (sum) sum.textContent = changed.length ? "Changed for this school: " + changed.map((k) => (D.SPEC.find((s) => s.key === k) || {}).label.trim()).join(", ") : "Using our standard terms";
        const ap = el("abApplyTxt");
        if (ap) {
          const jobs = jobsToApply(ctx, inp), dl = deliverablesOf(inp);
          const parts = [];
          if (dl.length) parts.push(jobs.length ? "add " + dl.length + " deliverable" + (dl.length === 1 ? "" : "s") + " (" + dl.join(", ") + ") to " + jobs.length + " school job" + (jobs.length === 1 ? "" : "s") + " in " + (inp.val.YEAR_START || "") + "-" + (inp.val.YEAR_END || "") + " that don&#8217;t have them yet"
            : "no school jobs in " + (inp.val.YEAR_START || "") + "-" + (inp.val.YEAR_END || "") + " to add deliverables to yet");
          if (inp.on.REBATE_PCT && parseFloat(inp.val.REBATE_PCT)) parts.push("set this partner&#8217;s payout to " + esc(inp.val.REBATE_PCT) + "% of sales");
          ap.innerHTML = "Apply to this partner&#8217;s jobs and payout terms when I send: " + (parts.length ? parts.join("; ") : "nothing to apply") + ". Nothing is removed.";
        }
      };
      refresh();
      const form = el("abForm");
      form.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(refresh, 120); });
      form.addEventListener("change", refresh);
      if (el("abWho")) el("abWho").addEventListener("change", () => {
        const c = contacts[+el("abWho").value]; if (!c) return;
        readForm(m, inp); fillContact(inp, c);
        ["CONTACT_NAME", "CONTACT_TITLE", "CONTACT_EMAIL", "CONTACT_PHONE"].forEach((k) => { const n = m.querySelector('[data-val="' + k + '"]'); if (n) n.value = inp.val[k] || ""; });
        refresh();
      });
      // A new term length moves the end year along with it.
      const ty = m.querySelector('[data-val="TERM_YEARS"]'), ysN = m.querySelector('[data-val="YEAR_START"]'), ey = m.querySelector('[data-val="END_YEAR"]');
      const syncEnd = () => { const a = parseInt(ysN.value, 10), t = parseInt(ty.value, 10); if (a && t && ey) { ey.value = String(a + t); refresh(); } };
      if (ty && ysN && !ro) { ty.addEventListener("change", syncEnd); ysN.addEventListener("change", syncEnd); }

      el("abCancel").addEventListener("click", () => m.close());
      el("abView").addEventListener("click", () => previewAsSchool(frozen ? ag.accepted_html : D.renderAgreement(readForm(m, inp)).html, org.name, ag));
      if (el("abStdSave")) el("abStdSave").addEventListener("click", async () => {
        readForm(m, inp);
        const p = {}; D.STANDARD_KEYS.forEach((k) => { p[k] = inp.val[k] || ""; });
        if (!confirm("Use these as the standard terms for every new school agreement? Agreements already made keep theirs.")) return;
        const { error: e2 } = await sb().rpc("agreement_defaults_save", { p });
        if (e2) return err(cleanErr(e2));
        ctx.defaults = p; refresh(); toast("Saved as our standard terms.");
      });

      const save = async () => {
        readForm(m, inp);
        err("");
        if (!inp.val.SCHOOL_NAME) { err("Add the school name first."); return null; }
        const r = D.renderAgreement(inp);
        const fallIso = inp.on.FALL ? D.isoOf(inp.val.FALL) : "";
        const springIso = inp.on.SPRING ? D.isoOf(inp.val.SPRING) : "";
        const endY = parseInt(inp.val.END_YEAR, 10);
        const p = { title: D.docTitle(inp), picture_day: fallIso || springIso || "", renewal_date: endY ? endY + "-06-30" : "", booking_id: bookingId || "" };
        const { data, error: e2 } = await sb().rpc("agreement_builder_save", { p_id: agId, p_org: org.id, p_builder: { on: inp.on, val: inp.val }, p_html: r.html, p_text: r.text, p });
        if (e2) { err(cleanErr(e2)); return null; }
        agId = (data && data.id) || agId;
        return agId;
      };
      if (el("abSave")) el("abSave").addEventListener("click", async () => {
        const b = el("abSave"); b.disabled = true;
        const id = await save(); b.disabled = false;
        if (!id) return;
        toast("Saved. It's a draft until you send it.");
        m.close();
        if (opts.onDone) opts.onDone(id);
      });
      if (el("abSend")) el("abSend").addEventListener("click", async () => {
        const b = el("abSend"); b.disabled = true;
        const id = await save();
        if (!id) { b.disabled = false; return; }
        if (el("abApply").checked) {
          const { data: ap, error: e3 } = await sb().rpc("agreement_builder_apply", { p_id: id, p_deliverables: deliverablesOf(inp) });
          if (e3) { b.disabled = false; return err(cleanErr(e3)); }
          if (ap && ap.message) toast(ap.message);
        }
        b.disabled = false;
        m.close();
        if (opts.onDone) opts.onDone(id);
        if (typeof Follow !== "undefined" && Follow.compose) Follow.compose("agreement", id, opts.onDone);
        else toast("Saved. Email it from Partners > Agreements.");
      });
      return m;
    }

    // What the school sees on admin.207photo.com/#agree/<token>, with the accept form shown but not working.
    function previewAsSchool(html, orgName, ag) {
      const m = openModal('<div class="ag-card" style="max-width:none"><p class="ab-noteline">This is the page the school gets from the link in your email. The form below is only a preview.</p>' +
        '<div class="ag-text ab-doc">' + D.sanitize(html) + "</div>" +
        (ag && ag.status === "accepted" ? "" : '<div class="field"><label>Your full name</label><input type="text" disabled /></div><div class="field"><label>Your role <span class="muted">(optional)</span></label><input type="text" disabled /></div>' +
          '<div class="field"><label>Your email, for your copy <span class="muted">(optional)</span></label><input type="text" disabled /></div>' +
          '<label class="ag-check"><input type="checkbox" disabled /> <span>I have read this agreement and accept it for ' + esc(orgName || "our organization") + ". Typing my name counts as my signature.</span></label>" +
          '<button type="button" class="primary" disabled>Accept agreement</button>') +
        '<div class="modal-actions"><span class="grow"></span><button type="button" class="small" id="aca-abVClose">Close</button></div></div>');
      m.classList.add("ab-modal");
      m.style.maxWidth = "760px";
      el("abVClose").addEventListener("click", () => m.close());
    }

    return { open, previewAsSchool };
  })();
  if (typeof window !== "undefined") { window.AgreementBuilder = AgreementBuilder; window.AgreementDoc = AgreementDoc; }
  if (typeof module === "object" && module && module.exports) module.exports = { AgreementDoc, renderAgreement };

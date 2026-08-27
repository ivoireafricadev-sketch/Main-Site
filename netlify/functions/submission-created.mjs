/**
 * Runs after every Netlify Forms submission.
 *
 * The file name is the contract: Netlify invokes a function called
 * "submission-created" once a submission is verified, and signs the call, so
 * there is no public endpoint here and no webhook to wire up.
 *
 * Two independent jobs:
 *   1. email the enquiry to the team (Resend)
 *   2. copy it into Airtable, if Airtable is configured at all
 *
 * They are deliberately independent - one failing must not stop the other -
 * and Netlify has already stored the submission before this runs, so even a
 * total failure here cannot lose a lead.
 */

const AIRTABLE_API = "https://api.airtable.com/v0";
const RESEND_API = "https://api.resend.com/emails";

/* Per-form settings. Table and recipient are env-driven so the client can
   rename a table or change who gets the email without a code change. */
const FORMS = {
  "ivoire-group-leads": {
    label: "Ivoire Group",
    source: "Group site",
    table: () => process.env.AIRTABLE_TABLE_GROUP || "Group Leads",
    to: () => process.env.LEAD_EMAIL_TO_GROUP,
  },
  "ivoire-mro-leads": {
    label: "MRO Solutions",
    source: "MRO Solutions page",
    table: () => process.env.AIRTABLE_TABLE_MRO || "MRO Leads",
    to: () => process.env.LEAD_EMAIL_TO_MRO,
  },
};

/* Form field -> label in the email and column in Airtable. This order is the
   order the rows appear in the email. */
const FIELDS = [
  ["name", "Name"],
  ["email", "Email"],
  ["phone", "Phone"],
  ["company", "Company"],
  ["country", "Country"],
  ["service", "Service"],
  ["message", "Message"],
];

/* Submissions are attacker-controlled text going into an HTML email. */
function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function buildEmailHtml(form, values, submittedAt) {
  const rows = FIELDS.filter(([key]) => values[key])
    .map(([key, label]) => {
      const weight = key === "message" ? "400" : "600";
      const value = escapeHtml(values[key]).replace(/\n/g, "<br>");
      const cell = "padding:11px 16px;border-bottom:1px solid #e6ebf0;";
      return [
        "<tr>",
        '<td style="' + cell + 'font:600 12px/1.4 Arial,sans-serif;letter-spacing:.06em;',
        'text-transform:uppercase;color:#5b6b7c;vertical-align:top;white-space:nowrap;">',
        label,
        "</td>",
        '<td style="' + cell + "font:" + weight + ' 14px/1.6 Arial,sans-serif;color:#0d1f33;">',
        value,
        "</td>",
        "</tr>",
      ].join("");
    })
    .join("");

  return [
    "<!doctype html>",
    '<html><body style="margin:0;padding:24px;background:#f4f7fa;">',
    '<table role="presentation" cellpadding="0" cellspacing="0" style="max-width:620px;margin:0 auto;',
    'background:#ffffff;border:1px solid #dfe6ed;border-radius:12px;overflow:hidden;">',
    '<tr><td style="padding:22px 26px;background:#072541;border-bottom:4px solid #F7C53E;">',
    '<div style="font:700 17px/1.3 Arial,sans-serif;color:#ffffff;">New enquiry &middot; ',
    escapeHtml(form.label),
    "</div>",
    '<div style="font:400 13px/1.5 Arial,sans-serif;color:#9db3c9;margin-top:5px;">Submitted ',
    escapeHtml(submittedAt),
    "</div></td></tr>",
    '<tr><td style="padding:8px 10px;">',
    '<table role="presentation" cellpadding="0" cellspacing="0" width="100%">',
    rows,
    "</table></td></tr>",
    '<tr><td style="padding:16px 26px;background:#f4f7fa;font:400 12px/1.6 Arial,sans-serif;color:#5b6b7c;">',
    "Reply to this email to answer ",
    escapeHtml(values.name || "the sender"),
    " directly.",
    "</td></tr>",
    "</table></body></html>",
  ].join("");
}

async function sendEmail(form, values, submittedAt) {
  const apiKey = process.env.RESEND_API_KEY;
  const to = form.to();

  if (!apiKey || !to) {
    console.log("email: RESEND_API_KEY or the recipient is not set, skipping");
    return "skipped";
  }

  // Falls back to Resend's shared test sender so the whole path works before
  // ivoireafrica.com is verified. Set LEAD_EMAIL_FROM once DNS is done.
  const from = process.env.LEAD_EMAIL_FROM || "Ivoire Enquiries <onboarding@resend.dev>";

  const who = values.name ? " - " + values.name : "";
  const subject = "New " + form.label + " enquiry - " + (values.service || "General") + who;

  const body = {
    from: from,
    to: to.split(",").map(a => a.trim()).filter(Boolean),
    subject: subject,
    html: buildEmailHtml(form, values, submittedAt),
  };

  // Lets the team hit reply and reach whoever filled the form in.
  if (values.email) body.reply_to = values.email;

  const response = await fetch(RESEND_API, {
    method: "POST",
    headers: { Authorization: "Bearer " + apiKey, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error("Resend returned " + response.status + " - " + (await response.text()));
  }

  console.log('email: sent "' + subject + '" to ' + body.to.join(", "));
  return "sent";
}

async function writeToAirtable(form, values, submittedAt) {
  const token = process.env.AIRTABLE_TOKEN;
  const baseId = process.env.AIRTABLE_BASE_ID;

  if (!token || !baseId) {
    console.log("airtable: not configured, skipping");
    return "skipped";
  }

  const fields = {};
  for (const [key, column] of FIELDS) {
    if (values[key]) fields[column] = values[key];
  }
  fields.Source = form.source;
  fields["Submitted At"] = submittedAt;

  const table = form.table();
  const url = AIRTABLE_API + "/" + baseId + "/" + encodeURIComponent(table);

  const response = await fetch(url, {
    method: "POST",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    // typecast lets Airtable match or create single-select options by name, so
    // a new dropdown value does not 422 the whole write.
    body: JSON.stringify({ typecast: true, records: [{ fields: fields }] }),
  });

  if (!response.ok) {
    throw new Error("Airtable returned " + response.status + " - " + (await response.text()));
  }

  console.log('airtable: wrote lead to "' + table + '"');
  return "written";
}

export async function handler(event) {
  let submission;
  try {
    submission = JSON.parse(event.body || "{}").payload || {};
  } catch {
    console.error("submission-created: body was not valid JSON");
    return { statusCode: 400, body: "Bad payload" };
  }

  const form = FORMS[submission.form_name];
  if (!form) {
    console.log('submission-created: no config for form "' + submission.form_name + '", skipping');
    return { statusCode: 200, body: "Ignored" };
  }

  const data = submission.data || {};
  const values = {};
  for (const [key] of FIELDS) {
    const value = data[key];
    if (typeof value === "string" && value.trim() !== "") values[key] = value.trim();
  }

  const submittedAt = submission.created_at || new Date().toISOString();

  // Settled independently: a broken Airtable token must not stop the email,
  // and a Resend outage must not stop the record being copied across.
  const [email, airtable] = await Promise.allSettled([
    sendEmail(form, values, submittedAt),
    writeToAirtable(form, values, submittedAt),
  ]);

  if (email.status === "rejected") console.error("email: " + email.reason.message);
  if (airtable.status === "rejected") console.error("airtable: " + airtable.reason.message);

  // A failed email shows red in the function log so it gets noticed. Netlify
  // still has the submission stored either way.
  if (email.status === "rejected") {
    return { statusCode: 500, body: "Email failed" };
  }

  const airtableState = airtable.status === "fulfilled" ? airtable.value : "failed";
  return { statusCode: 200, body: "email=" + email.value + " airtable=" + airtableState };
}

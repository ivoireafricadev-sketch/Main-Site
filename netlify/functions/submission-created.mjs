/**
 * Copies each Netlify Forms submission into Airtable.
 *
 * The file name is the contract: Netlify automatically invokes a function
 * called "submission-created" after every verified form submission, and signs
 * the invocation, so there is no public endpoint here and no webhook to wire
 * up in the dashboard.
 *
 * This runs *after* Netlify has already stored the submission and sent the
 * team notification email. Airtable is therefore a convenience copy, not the
 * system of record - if this function fails, the lead is not lost. Keep it
 * that way: never move the email or the storage responsibility in here.
 */

const AIRTABLE_API = "https://api.airtable.com/v0";

/* Maps the `name` attribute on each <form> to an Airtable table. Table names
   are overridable by env var so the client can rename tables in Airtable
   without a code change. */
const TABLE_FOR_FORM = {
  "ivoire-group-leads": () => process.env.AIRTABLE_TABLE_GROUP || "Group Leads",
  "ivoire-mro-leads": () => process.env.AIRTABLE_TABLE_MRO || "MRO Leads",
};

/* Form field name -> Airtable column name. Anything not listed is ignored, so
   adding a field to the HTML without adding it here silently drops it. */
const FIELD_MAP = {
  name: "Name",
  email: "Email",
  phone: "Phone",
  company: "Company",
  country: "Country",
  service: "Service",
  message: "Message",
};

export async function handler(event) {
  let submission;
  try {
    submission = JSON.parse(event.body || "{}").payload || {};
  } catch {
    console.error("submission-created: body was not valid JSON");
    return { statusCode: 400, body: "Bad payload" };
  }

  const formName = submission.form_name;
  const resolveTable = TABLE_FOR_FORM[formName];

  if (!resolveTable) {
    console.log(`submission-created: no Airtable table mapped for "${formName}", skipping`);
    return { statusCode: 200, body: "Ignored" };
  }

  const token = process.env.AIRTABLE_TOKEN;
  const baseId = process.env.AIRTABLE_BASE_ID;

  if (!token || !baseId) {
    // Deliberately not an error status: the lead is already captured and
    // emailed. A missing key is a setup problem, not a lost enquiry.
    console.error("submission-created: AIRTABLE_TOKEN or AIRTABLE_BASE_ID is not set");
    return { statusCode: 200, body: "Airtable not configured" };
  }

  const data = submission.data || {};
  const fields = {};

  for (const [formField, column] of Object.entries(FIELD_MAP)) {
    const value = data[formField];
    if (typeof value === "string" && value.trim() !== "") {
      fields[column] = value.trim();
    }
  }

  fields.Source = formName === "ivoire-mro-leads" ? "MRO Solutions page" : "Group site";
  fields["Submitted At"] = submission.created_at || new Date().toISOString();

  const table = resolveTable();
  const url = `${AIRTABLE_API}/${baseId}/${encodeURIComponent(table)}`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      // typecast lets Airtable match or create single-select options by name,
      // so a new service in the dropdown does not 422 the whole write.
      typecast: true,
      records: [{ fields }],
    }),
  });

  if (!response.ok) {
    const detail = await response.text();
    console.error(`submission-created: Airtable rejected the write (${response.status}) - ${detail}`);
    return { statusCode: 502, body: "Airtable write failed" };
  }

  console.log(`submission-created: wrote lead from ${fields.Email || "unknown"} to "${table}"`);
  return { statusCode: 200, body: "Recorded" };
}

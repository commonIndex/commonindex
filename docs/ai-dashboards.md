# Create a dashboard with AI

Open **Dashboards → New dashboard**. **Describe your dashboard** is visible
from the first step and remains above the source picker. Write your brief,
choose a connection, then pick a table or save a query using **Write SQL**.
Your description is kept when switching source modes or navigating back.
In the Panels step, the same brief appears at the top, ready to generate.
Typing or choosing a source does not automatically call the model.

1. **Suggest panels** asks the configured model for up to six panel definitions.
   It does not query warehouse rows or save a dashboard.
2. Review the explanation, measures, chart types and grouping. Deselect unwanted
   panels or use **Edit in builder** to adjust one manually. Using the suggested
   dashboard title is optional.
3. **Preview and add** runs real, sequential queries for the selected panels.
   If any fails, nothing is added; edit or deselect the failed suggestion and
   retry. Empty results are allowed and remain visibly empty, not sample data.
4. Review the charts in the draft. Existing panels are retained and colliding
   titles get a numeric suffix. **Create dashboard** is the separate save step,
   using the same metric-definition, permission and review workflow as manual
   authoring.

## Model configuration and data sent

This uses the existing model configuration, not an agent process or a new
runtime. `COMMONINDEX_LLM_BASE_URL` and `COMMONINDEX_LLM_MODEL` take priority (with
`COMMONINDEX_LLM_API_KEY` when needed). Otherwise it uses the configured
`COMMONINDEX_MODEL_PROVIDER` adapter and that provider's settings. See
[local model setup](local-model.md) for an on-device option.
The compatible endpoint must support `response_format` with `json_schema`, as
the Designs model adapter already requires. Schema output is requested only
for dashboard generation; existing prose calls are unchanged. The gateway
still validates all fields and source references independently of the provider.

Only the instruction, selected dataset identifier, column names/types, grouping
capabilities, time column and selected range go to the provider. Source query
text, rows, database DSNs and connection credentials are not included. Do not
put sensitive values into the instruction unless you intend to send them to
your configured provider. Model suggestions still need human review for
business meaning; syntactic validation cannot establish a correct KPI definition.

When no model is configured or a provider fails, the manual builder remains
available. Dismissing a request ignores its result; it does not guarantee
cancellation of an already-running provider call or warehouse query.

## Current scope

- One selected table or saved SQL dataset; no automatic joins or SQL generation.
- Count, distinct count, sum, average, minimum, maximum, ratio of sums and
  matching-share measures. String-category grouping and daily/weekly/monthly
  time buckets, when supported by the source.
- Number, line, area, bar, table and pie suggestions; other existing chart types
  can be chosen in the manual builder.
- No generated row filters. For joined/filtered data, first prepare and review
  a saved SQL source, then ask for panels on its output columns.
- Suggestions use a fixed selected time column and preview range. Changing
  either discards the old suggestion so the definitions and previews agree.

The registered `dashboards.generate` API/MCP operation requires workspace
`propose` permission, scopes the source lookup to that workspace, validates
model output against the real dataset and the ordinary authoring compiler, and
does not write anything. `panels.preview` and `dashboards.create` remain the
separate execution and save operations.

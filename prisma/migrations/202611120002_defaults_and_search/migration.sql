INSERT INTO "CaseStatus" (id, label, position) VALUES
  ('draft', 'Draft', 10), ('active', 'Active', 20), ('pending', 'Pending', 30),
  ('closed', 'Closed', 80), ('archived', 'Archived', 90);

INSERT INTO "Template" (type, headings) VALUES
  ('INCIDENT', ARRAY['Date and time', 'Location', 'Incident narrative', 'Actions taken', 'Outcome']),
  ('INTERROGATION', ARRAY['Date and participants', 'Questioning', 'Statements and follow-up']),
  ('INTERVIEW', ARRAY['Interviewee and date', 'Account', 'Follow-up']),
  ('ARREST', ARRAY['Date and location', 'Persons involved', 'Narrative', 'Disposition']),
  ('SUPPLEMENTAL', ARRAY['Original incident', 'Supplemental narrative', 'Action taken']),
  ('SURVEILLANCE', ARRAY['Date and location', 'Observations', 'Follow-up']),
  ('NOTES', ARRAY['Context', 'Notes', 'Follow-up']);

CREATE UNIQUE INDEX "Document_one_incident_per_case" ON "Document" ("caseId") WHERE type = 'INCIDENT';
CREATE INDEX "Case_search_fts" ON "Case" USING gin (to_tsvector('simple', title || ' ' || summary));
CREATE INDEX "Document_search_fts" ON "Document" USING gin (to_tsvector('simple', title || ' ' || "plainText")) WHERE "removedAt" IS NULL;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX "Case_title_trgm" ON "Case" USING gin (title gin_trgm_ops);
CREATE INDEX "Profile_name_trgm" ON "Profile" USING gin ("fullName" gin_trgm_ops);
CREATE INDEX "Person_name_trgm" ON "CasePerson" USING gin (name gin_trgm_ops);
CREATE INDEX "Case_number_lower" ON "Case" (lower(number));
CREATE INDEX "Profile_identifier_lower" ON "Profile" (lower(identifier));

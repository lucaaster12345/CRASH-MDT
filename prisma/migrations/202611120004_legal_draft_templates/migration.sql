INSERT INTO "Template" ("type", "headings") VALUES
  ('SUBPOENA', ARRAY['Jurisdiction and case reference', 'Recipient and service address', 'Records or testimony requested', 'Return date, time and location', 'Issuing authority and approval', 'Service details']),
  ('WARRANT_REQUEST', ARRAY['Jurisdiction and case reference', 'Requesting officer', 'Requested scope', 'Facts supporting the request', 'Attachments', 'Review and authorization']),
  ('AFFIDAVIT', ARRAY['Jurisdiction and case reference', 'Affiant and capacity', 'Statement of facts', 'Exhibits', 'Signature and attestation']),
  ('LEGAL_REQUEST', ARRAY['Jurisdiction and case reference', 'Requesting officer', 'Purpose and scope', 'Supporting facts and records', 'Review and approval'])
ON CONFLICT ("type") DO NOTHING;

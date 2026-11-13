ALTER TYPE "DocumentType" ADD VALUE 'SUBPOENA';
ALTER TYPE "DocumentType" ADD VALUE 'WARRANT_REQUEST';
ALTER TYPE "DocumentType" ADD VALUE 'AFFIDAVIT';
ALTER TYPE "DocumentType" ADD VALUE 'LEGAL_REQUEST';

ALTER TABLE "User" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "Case" ADD COLUMN "chargeVersion" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Document" ADD COLUMN "authorName" TEXT, ALTER COLUMN "authorId" DROP NOT NULL;
ALTER TABLE "Evidence" ADD COLUMN "submittedByName" TEXT, ALTER COLUMN "submittedById" DROP NOT NULL;
ALTER TABLE "Revision" ADD COLUMN "actorName" TEXT, ADD COLUMN "chargeVersion" INTEGER, ADD COLUMN "chargeSummary" JSONB;
ALTER TABLE "Audit" ADD COLUMN "actorName" TEXT;
ALTER TABLE "Task" ADD COLUMN "completedByName" TEXT;

UPDATE "Document" d SET "authorName" = u."displayName" FROM "User" u WHERE d."authorId" = u.id;
UPDATE "Evidence" e SET "submittedByName" = u."displayName" FROM "User" u WHERE e."submittedById" = u.id;
UPDATE "Revision" r SET "actorName" = u."displayName" FROM "User" u WHERE r."actorId" = u.id;
UPDATE "Audit" a SET "actorName" = u."displayName" FROM "User" u WHERE a."actorId" = u.id;
UPDATE "Task" t SET "completedByName" = u."displayName" FROM "User" u WHERE t."completedById" = u.id;

ALTER TABLE "Document" ALTER COLUMN "authorName" SET NOT NULL;
ALTER TABLE "Evidence" ALTER COLUMN "submittedByName" SET NOT NULL;
ALTER TABLE "Document" DROP CONSTRAINT "Document_authorId_fkey",
  ADD CONSTRAINT "Document_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Evidence" DROP CONSTRAINT "Evidence_submittedById_fkey",
  ADD CONSTRAINT "Evidence_submittedById_fkey" FOREIGN KEY ("submittedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CaseMember" DROP CONSTRAINT "CaseMember_userId_fkey",
  ADD CONSTRAINT "CaseMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CustodyNote" DROP CONSTRAINT "CustodyNote_evidenceId_fkey",
  ADD CONSTRAINT "CustodyNote_evidenceId_fkey" FOREIGN KEY ("evidenceId") REFERENCES "Evidence"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "PenalCharge" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "code" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "description" TEXT NOT NULL DEFAULT '',
  "custodyMinutes" INTEGER NOT NULL CHECK ("custodyMinutes" BETWEEN 0 AND 10000000),
  "fineCents" INTEGER NOT NULL CHECK ("fineCents" BETWEEN 0 AND 1000000000),
  "archivedAt" TIMESTAMP(3),
  "version" INTEGER NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX "PenalCharge_code_key" ON "PenalCharge"("code");

CREATE TABLE "SuspectCharge" (
  "personId" TEXT NOT NULL,
  "chargeId" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "custodyMinutes" INTEGER NOT NULL CHECK ("custodyMinutes" BETWEEN 0 AND 10000000),
  "fineCents" INTEGER NOT NULL CHECK ("fineCents" BETWEEN 0 AND 1000000000),
  "count" INTEGER NOT NULL CHECK ("count" BETWEEN 1 AND 100),
  CONSTRAINT "SuspectCharge_pkey" PRIMARY KEY ("personId", "chargeId"),
  CONSTRAINT "SuspectCharge_personId_fkey" FOREIGN KEY ("personId") REFERENCES "CasePerson"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "SuspectCharge_chargeId_fkey" FOREIGN KEY ("chargeId") REFERENCES "PenalCharge"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "SuspectCharge_chargeId_idx" ON "SuspectCharge"("chargeId");

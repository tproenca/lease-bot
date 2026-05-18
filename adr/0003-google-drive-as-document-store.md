# ADR-0003: Google Drive as Document Store
Date: 2026-05-18
Status: Accepted

## Context
Generated lease documents, merged PDFs, and signed documents need to be stored somewhere accessible to the landlord. Options included proprietary cloud storage managed by the application or the landlord's own Google Drive.

## Decision
Store all documents in the landlord's own Google Drive. The backend accesses Drive on the landlord's behalf via their Google OAuth token. Folder structure: `Root / {property} / {tenant} /` for apartments nested under `Root / {building} / {apt} / {tenant} /`.

## Alternatives Considered
- **Supabase Storage:** Centralized, easy to implement. Rejected because landlords lose direct access to their documents if they stop using the app, and it requires the developer to manage storage costs and data retention.
- **AWS S3:** Same concerns as Supabase Storage, plus more operational complexity.
- **Google Drive (shared drive owned by developer):** Easier auth but the landlord doesn't own their data. Rejected on principle.

## Consequences
- Landlords always have direct access to their documents in a tool they already use.
- No storage costs for the developer — Google Drive is the landlord's own account.
- The backend requires `https://www.googleapis.com/auth/drive` scope — a broad permission that must be clearly disclosed during onboarding.
- Drive folder IDs (not paths) are stored in the DB so renames don't break references.
- Current tenant folder is starred in Drive as a visual convenience; the DB remains the authoritative source.

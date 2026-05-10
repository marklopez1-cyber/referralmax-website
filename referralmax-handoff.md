# ReferralMax Trial Signup Funnel — Project Context Handoff

> **Purpose**: This document captures everything built and decided in a previous Claude conversation so work can resume in a new session without losing context. Paste or upload this document at the start of a new conversation and tell Claude: *"Read this and pick up where we left off."*

---

## TL;DR — What's done, what's left

**✅ DONE (live in production):**
- Fixed 19 Supabase security advisor findings (RLS issues, sensitive data exposure, search_path vulnerabilities, etc.)
- Built complete database schema for a multi-step trial signup funnel
- Deployed 2 Edge Functions: `send-trial-verification-email` and `validate-trial-address`
- Wired up Resend for verification emails (working — verified with real email delivery)
- Wired up Lob (test mode) for address validation (working — verified end-to-end)
- All API keys (`RESEND_API_KEY`, `LOB_API_KEY`) configured in Supabase secrets

**⏳ NOT DONE (next conversation should pick up here):**
- **Frontend integration into referralmax.ai marketing site**:
  1. Update the existing `#cta` form on the homepage to call the new Edge Function
  2. Build a new `/verify-trial` page that processes the email verification link
  3. Build a new `/complete-signup` page with the address form
  4. Update the success message ("we'll reach out today" → "check your email")
- Switch Lob from `test_` key to `live_` key when ready for production
- Deploy DNS records for any new email sending domains (Resend already has `referralmax.ai` verified)

---

## Project details

**Supabase project**: `referral-platform`
**Project ID**: `bacpbsbvgumykdqqqahj`
**Project URL**: `https://bacpbsbvgumykdqqqahj.supabase.co`
**Marketing site**: `https://referralmax.ai` (form lives at `#cta` anchor on homepage)
**Admin app**: `https://admin.referralmax.ai`
**Tenant pattern**: `<company-slug>.referralmax.ai` (e.g., `instant-heating-and-air-llc.referralmax.ai`)

**Stack signals from inspecting referralmax.ai**:
- Single-page marketing site with embedded signup form
- Likely static HTML (not WordPress/React based on canonical structure)
- Existing form fields: first_name, last_name, email, phone, company, industry, source ("how heard")
- Has anti-spam honeypot field "Website (do not fill)"

**Existing platform conventions** (use these patterns for any new work):
- All RLS policies follow: `is_superadmin_session() OR company_id = app_company_id()`
- Email service: **Resend** (3 existing API keys: `production`, `Receipts`, `InstantQuote`, plus new `ReferralMax Trial Signup`)
- Domain `referralmax.ai` is verified in Resend (DNS records already in place)
- Sender: `noreply@referralmax.ai`
- Support email: `support@referralmax.ai`

---

## Part 1: Security fixes completed

Original Supabase email flagged 2 issues for `referral-platform` project:
1. `rls_disabled_in_public` (turned out to be 8 tables affected)
2. `sensitive_columns_exposed` on `company_invites.token`

User chose to fix all of them, not just the 2 in the email.

### Migrations applied (in order):

**1. `enable_rls_on_remaining_public_tables`** — RLS enabled on 8 tables with policies matching existing pattern:
- `companies`, `company_invites`, `affiliate_contacts`, `affiliate_daily_sends`, `company_referral_credits`, `system_settings`, `trial_leads`, `short_urls`
- Special handling: `trial_leads` allows anon INSERT (for signup form); `short_urls` allows anon SELECT (for redirects)

**2. `harden_remaining_security_advisors`** — Added policies to 3 tables that had RLS but no policies (`announcement_recipients`, `announcements`, `superadmin_requests`); recreated `platform_overview` view with `security_invoker = true`; pinned `search_path` on 4 functions to prevent hijacking attacks (`app_company_id`, `is_superadmin_session`, `update_updated_at_column`, `seed_company_settings`).

**3. `tighten_audit_logs_insert_policy`** — Changed audit_logs INSERT from `WITH CHECK (true)` to require `is_superadmin_session() OR app_company_id() IS NOT NULL` (only authenticated app sessions).

**4. `add_helper_functions_for_anon_writes`** — Created two SECURITY DEFINER functions:
- `submit_trial_lead(...)` — Anon-callable wrapper for the signup form, returns inserted row
- `log_audit(...)` — Authenticated-callable from any context (cron, webhooks) without needing `app.company_id` set

**5. `revoke_public_execute_on_log_audit`** + **`revoke_anon_execute_on_log_audit_v2`** — Discovered Supabase has project-wide ALTER DEFAULT PRIVILEGES that auto-grant EXECUTE to anon on every new function. Had to explicitly REVOKE from anon to lock down `log_audit`.

### Final security state
- 19 findings → 1 intentional warning (`trial_leads` public INSERT for signup form)
- All ERRORs cleared
- Remaining warnings are intentional design choices (public-callable SECURITY DEFINER functions)

### Important security gotcha discovered
**Supabase project-wide default privileges auto-grant EXECUTE on functions to `anon`, `authenticated`, and `service_role`.** Whenever creating a new function that should NOT be anon-callable, you must explicitly `REVOKE EXECUTE ON FUNCTION ... FROM anon` after creating it. Granting to specific roles is not enough.

---

## Part 2: Trial signup funnel — Database

### Schema changes to `public.trial_leads`

Original table had: id, first_name, last_name, email, phone, company, industry, source, referred_by_code, ip_address, user_agent, status, created_at, updated_at.

Added 13 new columns:
- **Email verification**: `email_verified` (bool), `email_verify_token` (varchar(64)), `email_verify_expires` (timestamptz), `email_verified_at` (timestamptz)
- **Address fields**: `address_line1`, `address_line2`, `city`, `state` (varchar(2)), `zip_code` (varchar(10))
- **Address validation**: `address_validated` (bool), `address_validated_at` (timestamptz), `address_validation_data` (jsonb — stores full Lob response)

Widened `status` from varchar(20) to varchar(40).

### Status enum (new states added)
`new` → `email_verification_pending` → `email_verified` → `address_validated` → `contacted` → `converted` (or `declined`)

### `system_settings` entries added
- `trial_signup_site_url` = `https://referralmax.ai` — Used to build verification email links
- `trial_signup_email_from` = `ReferralMax <noreply@referralmax.ai>` — Resend sender
- `trial_signup_support_email` = `support@referralmax.ai`

These can be edited via SQL anytime without redeploying functions.

### Extension enabled
`pgcrypto` (in `extensions` schema) for `gen_random_bytes()` token generation.

### Postgres functions

**`submit_trial_lead(first_name, last_name, email, phone, company, industry, source, referred_by_code, ip_address, user_agent)`**
- SECURITY DEFINER, callable by `anon, authenticated, service_role`
- search_path: `public, extensions, pg_temp` (needs extensions for pgcrypto)
- Validates email format, generates 48-char URL-safe base64 token (256 bits entropy), inserts lead with status `email_verification_pending`, returns `{lead_id, email, status, email_verify_token, email_verify_expires}`
- Tokens expire after 48 hours

**`verify_trial_email(token)`**
- SECURITY DEFINER, callable by `anon, authenticated, service_role`
- Idempotent — clicking the verify link twice returns success both times
- Returns `{success, message, lead_id, first_name, email, company, status}`
- Marks `email_verified = true`, advances status to `email_verified`

**`submit_trial_address(token, address_line1, address_line2, city, state, zip_code, validation_data)`**
- SECURITY DEFINER, callable by **`service_role` ONLY** (anon explicitly revoked)
- Requires `email_verified = true` on the lead
- Persists Lob's standardized address + full validation response
- Advances status to `address_validated`

**`log_audit(action, entity_type, entity_id, user_id, old_values, new_values, ip_address, user_agent)`**
- SECURITY DEFINER, callable by `authenticated, service_role` (anon revoked)
- For use from cron jobs, webhooks, edge functions where `app.company_id` may not be set
- Returns `audit_log.id`

---

## Part 3: Edge Functions deployed

Both deployed via Supabase CLI 2.98.2 (installed via Scoop on Windows).

### `send-trial-verification-email`
- Public (no JWT verification)
- POST endpoint: `https://bacpbsbvgumykdqqqahj.supabase.co/functions/v1/send-trial-verification-email`
- Reads `RESEND_API_KEY` from secrets
- Calls `submit_trial_lead()` to create lead and get token
- Reads URL/sender config from `system_settings` (so URL changes don't require redeployment)
- Sends Resend email with verify link: `{trial_signup_site_url}/verify-trial?token={token}`
- Includes both HTML and plain-text email
- Captures client IP and user-agent for the lead record
- Returns: `{success, lead_id, email_sent, message}`

**Expected payload from frontend**:
```json
{
  "first_name": "...",
  "last_name": "...",
  "email": "...",
  "phone": "...",
  "company": "...",
  "industry": "...",
  "source": "..."
}
```

### `validate-trial-address`
- Public (no JWT verification)
- POST endpoint: `https://bacpbsbvgumykdqqqahj.supabase.co/functions/v1/validate-trial-address`
- Reads `LOB_API_KEY` from secrets
- Pre-checks token + email_verified BEFORE calling Lob (saves API quota)
- Calls Lob US Verification API: `https://api.lob.com/v1/us_verifications`
- Acceptable deliverability: `deliverable`, `deliverable_unnecessary_unit`
- Returns 422 with suggestion if address didn't validate
- On success, calls `submit_trial_address()` with Lob's standardized values
- Returns: `{success, lead_id, status, deliverability, standardized_address, message}`

**Expected payload from frontend**:
```json
{
  "token": "...",
  "primary_line": "123 Main St",
  "secondary_line": "Apt 4B",
  "city": "Phoenix",
  "state": "AZ",
  "zip_code": "85001"
}
```

### Lob test mode magic values (for testing without burning quota)
- `primary_line: "deliverable"` + `zip_code: "11111"` → returns deliverable mock
- `primary_line: "undeliverable"` → returns undeliverable
- Real addresses in test mode return `undeliverable` with educational error message

---

## Part 4: Secrets configured in Supabase

Set in Dashboard → Edge Functions → Secrets:

| Name | Value | Notes |
|---|---|---|
| `RESEND_API_KEY` | `re_...` (from "ReferralMax Trial Signup" key in Resend) | Sending access only, all domains |
| `LOB_API_KEY` | `test_...` (from Lob Test Environment) | **Switch to `live_...` when going to production** |

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are auto-injected by Supabase.

---

## Part 5: End-to-end flow (verified working)

```
1. User fills #cta form on referralmax.ai
   ↓
2. POST → send-trial-verification-email Edge Function
   ↓
3. Edge Function calls submit_trial_lead() → token generated
   Lead created with status = 'email_verification_pending'
   ↓
4. Edge Function sends email via Resend
   ↓
5. User clicks link → /verify-trial?token=xxx [PAGE NEEDS TO BE BUILT]
   ↓
6. Frontend calls verify_trial_email(token) via Supabase RPC
   Lead status → 'email_verified'
   ↓
7. Frontend shows address form [PAGE NEEDS TO BE BUILT]
   ↓
8. POST → validate-trial-address Edge Function
   ↓
9. Edge Function calls Lob API (after checking email_verified)
   ↓
10. Edge Function calls submit_trial_address() → saves Lob payload
    Lead status → 'address_validated'
    ↓
11. Frontend shows "you're all set" message
    Sales team takes over from there
```

**Tested in previous session**:
- ✅ Step 1-4: Email arrived in real inbox from `noreply@referralmax.ai`
- ✅ Step 6: `verify_trial_email()` returned success, status updated
- ✅ Step 8-10: Lob test-mode call returned standardized address, lead reached `address_validated`

---

## Part 6: Frontend work to be done (this is what's next)

### What needs to be built on referralmax.ai

**A. Update existing form on `#cta`** (homepage)

Replace the current form-submit handler to POST to the Edge Function:
```javascript
async function submitTrialSignup(formData) {
  const response = await fetch(
    'https://bacpbsbvgumykdqqqahj.supabase.co/functions/v1/send-trial-verification-email',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        first_name: formData.first_name,
        last_name: formData.last_name,
        email: formData.email,
        phone: formData.phone,
        company: formData.company,
        industry: formData.industry,
        source: formData.source,
      }),
    }
  );
  const result = await response.json();
  if (!response.ok || !result.success) throw new Error(result.error || 'Signup failed');
  return result;
}
```

Update success message FROM:
> "Request received! We'll reach out today during business hours..."

TO:
> "Almost there! We've sent a verification email to {email}. Please click the link in that email to continue setting up your trial."

**B. Build new `/verify-trial` page**

Reads `?token=...` from URL, calls `verify_trial_email` RPC, shows next-step UI.
Needs the Supabase **publishable (anon) key** — get from https://supabase.com/dashboard/project/bacpbsbvgumykdqqqahj/settings/api-keys

```javascript
const params = new URLSearchParams(window.location.search);
const token = params.get('token');
const SUPABASE_URL = 'https://bacpbsbvgumykdqqqahj.supabase.co';
const ANON_KEY = 'eyJ...'; // PASTE THE ANON KEY HERE

async function verifyEmail() {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/verify_trial_email`, {
    method: 'POST',
    headers: {
      'apikey': ANON_KEY,
      'Authorization': `Bearer ${ANON_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ p_token: token }),
  });
  const result = await response.json();
  return result[0]; // function returns array
}
```

**C. Build address form** (could be on same page or `/complete-signup?token=...`)

```javascript
async function submitAddress(token, addressForm) {
  const response = await fetch(
    'https://bacpbsbvgumykdqqqahj.supabase.co/functions/v1/validate-trial-address',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token,
        primary_line: addressForm.street,
        secondary_line: addressForm.unit,
        city: addressForm.city,
        state: addressForm.state,
        zip_code: addressForm.zip,
      }),
    }
  );
  const result = await response.json();
  if (response.status === 422) {
    return { ok: false, message: result.message, suggestion: result.suggested_address };
  }
  if (!response.ok) throw new Error(result.error || 'Address validation failed');
  return { ok: true, standardized: result.standardized_address };
}
```

### What we don't know yet
- Whether the user has direct access to edit referralmax.ai HTML files (last conversation ended before answering this)
- Where referralmax.ai is hosted (Vercel, Netlify, Cloudflare Pages, etc.)
- Whether someone else maintains the site

These need to be answered before the frontend integration can be deployed.

---

## Part 7: Known issues and operational notes

### Resending verification emails
Not yet built. If a user loses the email, they currently have to start over. Easy to add later as a `resend_trial_verification(email)` Postgres function.

### Trial signup INSERT with RETURNING
Direct INSERT to `trial_leads` from anon works (single statement), but `INSERT ... RETURNING` fails because anon can't SELECT from `trial_leads`. The `submit_trial_lead()` SECURITY DEFINER function is the workaround — it returns the row safely.

### Audit log writes
Existing app code that does `INSERT INTO audit_logs` will keep working **only if** the session has `app.company_id` set. For cron jobs, webhooks, or any context without that session var, use the new `log_audit()` function instead.

### Cost projections
| Monthly leads | Resend cost | Lob cost |
|---|---|---|
| 50 | Free | Free |
| 500 | Free | Free (right at limit) |
| 2000 | Free | ~$120/mo |
| 10000 | ~$20/mo | ~$700/mo |

If exceeding Lob's 500/mo free tier, consider deferring address validation to after a sales conversation rather than at signup.

### Funnel monitoring SQL
```sql
SELECT
  status,
  count(*) AS leads,
  count(*) FILTER (WHERE created_at > now() - interval '7 days') AS last_7d
FROM public.trial_leads
GROUP BY status
ORDER BY status;
```

---

## Part 8: Conversation context for the new Claude

The new Claude session should know:

1. **User is the business owner**, not a developer. They followed instructions step-by-step in Git Bash on Windows successfully but needed handholding through CLI installation, file paths, and basic commands. Be patient and explicit. Don't assume technical familiarity.

2. **User uses Git Bash on Windows 11**. Scoop is installed, Supabase CLI 2.98.2 works.

3. **User is logged in to Supabase CLI** as `markl@gmail.com` and project is linked.

4. **The 'project-ref' for all Supabase commands is `bacpbsbvgumykdqqqahj`**.

5. **Don't paste-bomb scripts**. The user had an issue earlier where a script with `set -e` and `exit 1` closed their Git Bash window. Always wrap multi-step bash in functions or give one command at a time.

6. **Don't volunteer to do things you can't actually do**. The user expected Claude to have access to the referralmax.ai codebase because Claude had viewed the public site. Be explicit about the boundary: Claude can fetch public URLs but can't access user files unless they're uploaded to the conversation.

7. **The user is `marklopez1-cyber's Org` on Supabase**, owner of referral-platform project. They have one company in production: "Instant Heating and Air, LLC" (slug: `instant-heating-and-air-llc`).

---

## Part 9: How to resume in a new conversation

Open a new Claude conversation and paste this prompt:

> I'm continuing work from a previous conversation on building a trial signup funnel for ReferralMax. Please read the attached document fully, then help me with the next step which is: **building the frontend pages on referralmax.ai to wire into the backend that's already deployed.**
>
> Specifically I need:
> 1. The form on the homepage (#cta anchor) updated to call the new Edge Function
> 2. A new /verify-trial page that processes the email verification link
> 3. A new /complete-signup page (or merged with verify-trial) that shows the address form
>
> Before writing any code, please ask me whether I have direct edit access to the referralmax.ai source files, where it's hosted, and whether you should give me drop-in HTML files or framework-specific code.

Then attach this document.

---

*Document created at end of session for handoff to new conversation.*

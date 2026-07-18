import { initializeApp } from 'firebase-admin/app'
import { getStorage } from 'firebase-admin/storage'
import { getFirestore } from 'firebase-admin/firestore'
import { getAuth } from 'firebase-admin/auth'
import { onCall, HttpsError } from 'firebase-functions/v2/https'
import { onDocumentCreated } from 'firebase-functions/v2/firestore'
import { defineSecret } from 'firebase-functions/params'
import { buildMagicLinkEmail } from './emailTemplate.js'

initializeApp()

// Secrets — set these via Firebase CLI before deploying:
//   firebase functions:secrets:set VAPI_API_KEY
//   firebase functions:secrets:set VAPI_VOICE_EN   (Vapi voice ID for English)
//   firebase functions:secrets:set VAPI_VOICE_FR   (Vapi voice ID for French)
//   firebase functions:secrets:set RESEND_API_KEY  (for magic-link + notification emails)
const VAPI_API_KEY   = defineSecret('VAPI_API_KEY')
const VAPI_VOICE_EN  = defineSecret('VAPI_VOICE_EN')
const VAPI_VOICE_FR  = defineSecret('VAPI_VOICE_FR')
const RESEND_API_KEY = defineSecret('RESEND_API_KEY')

const MAIL_FROM = "Yezi's Knowledge Hub <hello@yezihub.com>"
const ADMIN_EMAIL = 'yezi.lilyz@gmail.com'

async function sendViaResend(apiKey: string, opts: { to: string; subject: string; html: string; text: string; replyTo?: string }) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: MAIL_FROM,
      to: [opts.to],
      subject: opts.subject,
      html: opts.html,
      text: opts.text,
      reply_to: opts.replyTo,
    }),
  })
  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Resend API error ${res.status}: ${err}`)
  }
  return res.json()
}

interface Section { id: string; text: string }

// generateGuideAudio — called from AdminHub's "Generate audio" button.
// Synthesizes speech per section via Vapi TTS, caches audio files in
// Firebase Storage under audio/{guideId}/{sectionId}_{lang}.mp3,
// and writes the resulting public URLs back to the guide's Firestore doc.
// Requires: Blaze plan + VAPI_API_KEY / VAPI_VOICE_* secrets set.
export const generateGuideAudio = onCall(
  { secrets: [VAPI_API_KEY, VAPI_VOICE_EN, VAPI_VOICE_FR], cors: true },
  async (request) => {
    const { guideId, lang, sections } = request.data as {
      guideId: string
      lang: 'en' | 'fr'
      sections: Section[]
    }

    if (!guideId || !lang || !Array.isArray(sections) || sections.length === 0) {
      throw new HttpsError('invalid-argument', 'Missing guideId, lang, or sections.')
    }

    const bucket  = getStorage().bucket()
    const db      = getFirestore()
    const voiceId = lang === 'fr' ? VAPI_VOICE_FR.value() : VAPI_VOICE_EN.value()
    const audioUrls: Record<string, string> = {}

    for (const section of sections) {
      const filePath = `audio/${guideId}/${section.id}_${lang}.mp3`
      const file     = bucket.file(filePath)

      // Return cached file if it already exists (skip regeneration)
      const [exists] = await file.exists()
      if (exists) {
        audioUrls[section.id] = buildPublicUrl(bucket.name, filePath)
        continue
      }

      // ── Vapi TTS synthesis ────────────────────────────────────────────────
      // Vapi REST endpoint for text-to-speech synthesis.
      // Docs: https://docs.vapi.ai/api-reference/tts/synthesize
      // Voice config: adjust provider/voiceId below after confirming your Vapi setup.
      const response = await fetch('https://api.vapi.ai/speech/synthesize', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${VAPI_API_KEY.value()}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          input: section.text,
          voice: {
            // Change provider to match your Vapi voice configuration:
            // 'elevenlabs' | 'openai' | 'azure' | 'playht' | 'deepgram'
            provider: 'elevenlabs',
            voiceId,
          },
        }),
      })

      if (!response.ok) {
        const err = await response.text()
        console.error(`Vapi TTS failed for section ${section.id}:`, err)
        throw new HttpsError('internal', `Vapi TTS error for section ${section.id}: ${err}`)
      }

      // Save audio to Firebase Storage (publicly readable per storage.rules)
      const buffer = Buffer.from(await response.arrayBuffer())
      await file.save(buffer, {
        contentType: 'audio/mpeg',
        metadata: { cacheControl: 'public, max-age=31536000' },
      })
      await file.makePublic()

      audioUrls[section.id] = buildPublicUrl(bucket.name, filePath)
    }

    // Persist URLs to Firestore so TtsPlayer can load them without calling
    // this function again — all future listens are instant from Storage CDN.
    const urlField       = lang === 'en' ? 'audioUrls_en'       : 'audioUrls_fr'
    const timestampField = lang === 'en' ? 'audioGeneratedAt_en' : 'audioGeneratedAt_fr'
    await db.collection('guides').doc(guideId).update({
      [urlField]:       audioUrls,
      [timestampField]: new Date().toISOString(),
    })

    return { audioUrls, count: Object.keys(audioUrls).length }
  }
)

function buildPublicUrl(bucket: string, path: string): string {
  return `https://storage.googleapis.com/${bucket}/${path}`
}

// ── translateTexts — proxies OpenAI translation server-side ─────────────────
// OpenAI's chat completions endpoint has no CORS headers for browser origins
// ("No 'Access-Control-Allow-Origin' header is present"), so calling it
// directly from AdminHub.tsx in the browser fails unconditionally — with any
// key, valid or not. This function makes the same call from a server
// environment (no CORS restriction applies server-to-server) and returns the
// result to the client. The API key still comes from the client's own request
// payload (same as before: entered in the browser, stored in localStorage,
// never committed to source) — this function only relays it to OpenAI, it
// does not store it.
//
// Keep SEP / buildTranslationPrompt in sync with the copies in
// src/components/AdminHub.tsx (SEP, TRANSLATION_PROMPT) — duplicated here
// because functions/ is a separate TypeScript project with no shared module
// between client and functions today.
const TRANSLATE_SEP = '\n〈§〉\n'

function buildTranslationPrompt(texts: string[]): string {
  const keepTerms = 'PM, OKR, sprint, backlog, roadmap, KPI, API, SaaS, B2B, B2C, GTM, NPS, UX, UI, CRM, SLA, MVP, KYC, ARR, MRR, CLV, DAU, MAU, framework, playbook, pipeline, funnel, ICP, CAC, LTV'
  return `You are a professional translator specialising in product management and technology content. Translate the following English text segments to French.

Rules:
- Keep these terms in English: ${keepTerms}
- Keep company names, product names, people's names unchanged
- Return ONLY the translated segments separated by exactly "${TRANSLATE_SEP}", with no preamble, explanation, or trailing text
- If a segment is already French, a number, code, symbol, or very short punctuation, return it unchanged
- Preserve the capitalisation style of the original (ALL CAPS stays ALL CAPS, Title Case stays Title Case)

Segments to translate:
${texts.join(TRANSLATE_SEP)}`
}

export const translateTexts = onCall(
  { cors: true },
  async (request) => {
    const { texts, apiKey } = request.data as { texts: string[]; apiKey: string }

    if (!Array.isArray(texts) || texts.length === 0) {
      throw new HttpsError('invalid-argument', 'texts must be a non-empty array of strings.')
    }
    if (!apiKey) {
      throw new HttpsError('invalid-argument', 'apiKey is required.')
    }

    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        max_tokens: 8096,
        messages: [{ role: 'user', content: buildTranslationPrompt(texts) }],
      }),
    })

    if (!res.ok) {
      const err = await res.text()
      throw new HttpsError('internal', `OpenAI API error ${res.status}: ${err}`)
    }

    const data = await res.json() as { choices?: { message?: { content?: string } }[] }
    const raw = data.choices?.[0]?.message?.content || ''
    // The model doesn't always reproduce the exact separator glyphs (it can
    // substitute a visually-similar Unicode bracket pair around "§"), so
    // split tolerantly on any punctuation/whitespace around § rather than
    // the literal TRANSLATE_SEP string — otherwise a single substitution
    // silently merges two segments into one instead of raising an error.
    // IMPORTANT: use \p{L}/\p{N} (Unicode letter/number), not \w — \w is
    // ASCII-only, so a French segment starting with an accented capital
    // right against the separator (e.g. "§Étude") had its leading "É"
    // swallowed as if it were separator punctuation ("tude" came out).
    const parts = raw.split(/\s*[^\p{L}\p{N},.]*§[^\p{L}\p{N},.]*\s*/gu)
    // Beyond glyph substitution, the model can also silently merge/reformat
    // many short segments in a large batch instead of respecting the
    // separator at all (verified: 736 segments in -> 347 parts out, with
    // finish_reason "stop", not truncation). Silently padding missing parts
    // with the original English text hides this and lets most of a guide's
    // translation get corrupted with no error. Fail loudly instead so the
    // caller's chunked retry-at-half-size logic (see translateSegmentsSafe
    // in AdminHub.tsx) can recover with a smaller, reliable batch.
    if (parts.length !== texts.length) {
      throw new HttpsError('internal', `Segment count mismatch: sent ${texts.length}, got ${parts.length} back from the model.`)
    }
    const translated = parts.map(p => p.trim())

    return { translated }
  }
)

// ── judgeTranslation — general-purpose OpenAI chat call for post-translation
// quality review. Same CORS-workaround reasoning as translateTexts: OpenAI
// has no CORS headers for browser origins, so this must be relayed through
// a Cloud Function. Unlike translateTexts, this isn't translation-specific —
// it takes an arbitrary prompt (built client-side) and returns the raw
// response text, used by AdminHub.tsx to have the model judge whether a
// just-produced French translation actually reads well, as a second check
// beyond the deterministic refusal-pattern scan.
export const judgeTranslation = onCall(
  { cors: true },
  async (request) => {
    const { prompt, apiKey } = request.data as { prompt: string; apiKey: string }

    if (!prompt || typeof prompt !== 'string') {
      throw new HttpsError('invalid-argument', 'prompt must be a non-empty string.')
    }
    if (!apiKey) {
      throw new HttpsError('invalid-argument', 'apiKey is required.')
    }

    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        max_tokens: 300,
        messages: [{ role: 'user', content: prompt }],
      }),
    })

    if (!res.ok) {
      const err = await res.text()
      throw new HttpsError('internal', `OpenAI API error ${res.status}: ${err}`)
    }

    const data = await res.json() as { choices?: { message?: { content?: string } }[] }
    const verdict = (data.choices?.[0]?.message?.content || '').trim()
    return { verdict }
  }
)

export const extractMetadata = onCall(
  { cors: true },
  async (request) => {
    const { htmlContent, apiKey } = request.data as { htmlContent: string; apiKey: string }
    if (!htmlContent || !apiKey) {
      throw new HttpsError('invalid-argument', 'htmlContent and apiKey are required.')
    }

    // Keep "tag"/"level"/"topics"/"overlay"/"format" in sync with
    // CONTENT_TYPES/LEVELS/TOPICS/OVERLAYS/FORMAT_TYPES in AdminHub.tsx —
    // these are controlled taxonomies (see guide-builder taxonomy-audit
    // artifact, 2026-07-18), not freeform text, so the model must pick
    // exactly from these lists rather than inventing its own label. "chips"
    // stays freeform — it's cosmetic flavor text on the card now, no longer
    // load-bearing for matching/browsing.
    const systemPrompt = `Extract or generate the following metadata from the provided HTML content.
Return ONLY a strictly valid JSON object matching the schema. No markdown, no prefixes.
{
  "title": "Title of the document (keep it short)",
  "description": "A 1-2 sentence compelling summary of what this document is about.",
  "tag": "EXACTLY one of: Playbook, Framework, Case Study/Teardown, Field Guide, Toolkit, Interview Guide, Personal Notes — pick whichever best matches the content's actual structure and purpose",
  "level": "EXACTLY one of: Beginner, Intermediate, Advanced — your best judgment of the reader experience level this content assumes or targets",
  "topics": ["1-2 values, EXACTLY from: Growth & Retention, Strategy & Positioning, Team & Organization, Building & Shipping, Operating Cadence & Communication, Discovery & Research, Launch & Go-to-Market, Planning & Prioritization, Career"],
  "overlay": ["0-2 values, EXACTLY from: Zero-to-One / Founder, Marketplace, Building AI Products, Enterprise/PLG — only include one if the content specifically targets that context, most guides have none"],
  "format": ["0-2 values, EXACTLY from: Checklist, Templates, Interactive Tool, Reference"],
  "chips": ["array", "of", "up", "to", "3", "short", "descriptive", "tags", "e.g.", "Linear agent", "Product Strategy"]
}
Field notes:
- "topics": pick the single best-matching category; only include a second if the content genuinely spans two of them equally — don't pad to 2 for the sake of it. Use "Career" only for career/networking/mentorship content, not general PM strategy.
- "format": "Checklist" if there's a validation/checklist section, "Templates" if there are copy-ready templates/snippets, "Interactive Tool" if there are working calculators/simulators, "Reference" if none of those apply (the default — most guides are Reference). Checklist and Templates can combine if both are genuinely present.
"topics", "overlay", and "format" MUST always be JSON arrays (e.g. ["Career"]), even when there's only one value or the array is empty — never a bare string.
If a field cannot be reasonably determined, leave it as an empty string (or empty array for chips/topics/overlay/format) — but always make your best guess for "tag", "level", and "topics" rather than leaving them empty, since every guide needs one of each.`

    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        max_tokens: 500,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `HTML Content:\n\n${htmlContent.slice(0, 15000)}` }
        ],
      }),
    })

    if (!res.ok) {
      const err = await res.text()
      throw new HttpsError('internal', `OpenAI API error ${res.status}: ${err}`)
    }

    const data = await res.json() as { choices?: { message?: { content?: string } }[] }
    const raw = data.choices?.[0]?.message?.content || '{}'
    return { metadataStr: raw }
  }
)

// ── sendMagicLinkEmail — replaces client-side sendSignInLinkToEmail ─────────
// Firebase Auth's own email-sending has two problems: its template can't be
// restyled beyond basic text edits, and it sends from a shared Firebase
// domain with no SPF/DKIM alignment, which readers' inboxes flag as spam.
// This generates the same kind of sign-in link server-side (Admin SDK) and
// sends it through Resend with a verified custom domain (yezihub.com) and a
// fully custom branded HTML template instead.
export const sendMagicLinkEmail = onCall(
  { secrets: [RESEND_API_KEY], cors: true },
  async (request) => {
    const { email, url, lang, name, mode } = request.data as {
      email: string
      url: string
      lang?: 'en' | 'fr'
      name?: string
      mode?: 'signup' | 'login'
    }

    if (!email || !url) {
      throw new HttpsError('invalid-argument', 'email and url are required.')
    }

    const link = await getAuth().generateSignInWithEmailLink(email, {
      url,
      handleCodeInApp: true,
    })

    const { subject, html, text } = buildMagicLinkEmail({
      link,
      lang: lang === 'fr' ? 'fr' : 'en',
      mode: mode === 'login' ? 'login' : 'signup',
      name,
    })

    try {
      await sendViaResend(RESEND_API_KEY.value(), { to: email, subject, html, text })
    } catch (err) {
      throw new HttpsError('internal', `Failed to send email: ${(err as Error).message}`)
    }

    return { success: true }
  }
)

// ── notifyOnNewSubscriber — pings the admin by email on every new signup ────
// Low volume (one email per real signup), so real-time rather than batched
// like the weekly traffic report.
export const notifyOnNewSubscriber = onDocumentCreated(
  { document: 'subscribers/{subscriberId}', secrets: [RESEND_API_KEY] },
  async (event) => {
    const data = event.data?.data()
    if (!data) return

    const name = data.name || '(no name given)'
    const email = data.email || '(no email)'
    const guideId = data.guideId ? ` while viewing guide ${data.guideId}` : ''

    await sendViaResend(RESEND_API_KEY.value(), {
      to: ADMIN_EMAIL,
      subject: `New signup: ${name} <${email}>`,
      html: `<p>New subscriber${guideId}:</p><p><strong>${name}</strong><br>${email}</p>`,
      text: `New subscriber${guideId}: ${name} <${email}>`,
      replyTo: email,
    })
  }
)

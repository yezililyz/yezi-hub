import { initializeApp } from 'firebase-admin/app'
import { getStorage } from 'firebase-admin/storage'
import { getFirestore } from 'firebase-admin/firestore'
import { onCall, HttpsError } from 'firebase-functions/v2/https'
import { defineSecret } from 'firebase-functions/params'

initializeApp()

// Secrets — set these via Firebase CLI before deploying:
//   firebase functions:secrets:set VAPI_API_KEY
//   firebase functions:secrets:set VAPI_VOICE_EN   (Vapi voice ID for English)
//   firebase functions:secrets:set VAPI_VOICE_FR   (Vapi voice ID for French)
const VAPI_API_KEY   = defineSecret('VAPI_API_KEY')
const VAPI_VOICE_EN  = defineSecret('VAPI_VOICE_EN')
const VAPI_VOICE_FR  = defineSecret('VAPI_VOICE_FR')

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
    const parts = raw.split(TRANSLATE_SEP)
    const translated = texts.map((t, i) => (parts[i]?.trim() || t))

    return { translated }
  }
)

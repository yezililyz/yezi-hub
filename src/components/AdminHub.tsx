import { useState, useEffect, useRef, useCallback } from 'react'
import ImageEditorModal from './ImageEditorModal'
import PinnedCarousel from './PinnedCarousel'
import {
  collection, addDoc, getDocs, updateDoc, deleteDoc,
  doc, serverTimestamp, orderBy, query, getDoc, setDoc
} from 'firebase/firestore'
import { getFunctions, httpsCallable } from 'firebase/functions'
import { signOut } from 'firebase/auth'
import { ref, uploadString, getDownloadURL, deleteObject } from 'firebase/storage'
import { db, auth, storage } from '../firebase'

// ─── Interfaces ──────────────────────────────────────────────────────────────

interface Guide {
  id: string
  title: string
  title_fr?: string
  description: string
  description_fr?: string
  icon: string
  tag: string
  tag_fr?: string
  chips: string[]
  chips_fr?: string[]
  level?: string
  level_fr?: string
  htmlContent: string
  htmlContent_fr?: string
  // Large guides (over INLINE_LIMIT_BYTES) store their HTML in Storage instead
  // of inline — htmlContent/_fr is then null and this URL is fetched at read time.
  htmlUrl?: string | null
  htmlUrl_fr?: string | null
  published: boolean
  visibility?: 'public' | 'private' | 'draft'
  private?: boolean
  order: number
  filename: string
  filename_fr?: string
  sectionId?: string | null
  pinned?: boolean
  audioUrls_en?: Record<string, string>
  audioUrls_fr?: Record<string, string>
  audioGeneratedAt_en?: string
  audioGeneratedAt_fr?: string
}

interface Section {
  id: string
  name: string
  name_fr?: string
  intro: string
  intro_fr?: string
  order: number
  megaGroup?: string
}

// Top-level grouping sections nest under, both in the admin guide list and
// the public site's section nav/filters — see guide-builder/RECURRENT_BUGS.md.
const MEGA_GROUPS = ['Product', 'Tools', 'Books'] as const

interface SiteMeta {
  title: string
  title_fr?: string
  tagline: string
  tagline_fr?: string
  subtitle: string
  subtitle_fr?: string
}

interface LinkItem {
  id: string
  title: string
  title_fr?: string
  url: string
}

interface LinkList {
  id: string
  title: string
  title_fr?: string
  sectionId: string | null
  order: number
  items: LinkItem[]
}

// A curated, ordered sequence of the site's OWN guides forming a "program" a
// reader works through top to bottom — distinct from LinkList, which curates
// external URLs.
interface Playlist {
  id: string
  title: string
  title_fr?: string
  description: string
  description_fr?: string
  icon: string
  order: number
  published: boolean
  guideIds: string[]
}

interface Subscriber {
  id: string
  name: string
  email: string
  guideId: string | null
  signedUpAt: string
}

interface ParsedMeta {
  title: string
  description: string
  icon: string
  tag: string
  chips: string
  order: number
}

interface Toast { message: string; type: 'success' | 'error' }
interface Confirm { message: string; onConfirm: () => void }

// ─── Hooks ───────────────────────────────────────────────────────────────────

function useToast() {
  const [toast, setToast] = useState<Toast | null>(null)
  const show = useCallback((message: string, type: Toast['type'] = 'success') => {
    setToast({ message, type })
    setTimeout(() => setToast(null), 2800)
  }, [])
  return { toast, show }
}

// ─── Constants ───────────────────────────────────────────────────────────────

// Client-side sanity cap on the file picked/dropped for upload. Not a Firestore
// constraint — large files route to Storage (see persistGuideHtml) — this just
// guards against something absurd hanging the DOMParser/translation pipeline.
const MAX_SIZE_BYTES = 20_000_000

// Controlled taxonomy — see guide-builder/RECURRENT_BUGS.md taxonomy cleanup.
// `tag`/`tag_fr` hold the content type (was freeform before, now one of these);
// `level`/`level_fr` are a new field. Keep both dropdowns driven by this list
// so the vocabulary can't drift back into one-off free text per guide.
const CONTENT_TYPES: { en: string; fr: string }[] = [
  { en: 'Playbook', fr: 'Guide pratique' },
  { en: 'Framework', fr: 'Cadre méthodologique' },
  { en: 'Case Study/Teardown', fr: 'Étude de cas' },
  { en: 'Field Guide', fr: 'Guide de référence' },
  { en: 'Toolkit', fr: 'Boîte à outils' },
  { en: 'Interview Guide', fr: "Guide d'entretien" },
]
const LEVELS: { en: string; fr: string }[] = [
  { en: 'Beginner', fr: 'Débutant' },
  { en: 'Intermediate', fr: 'Intermédiaire' },
  { en: 'Advanced', fr: 'Avancé' },
]

// Firestore hard-caps a document at 1 MiB (1,048,576 bytes) total, across ALL
// fields, and is NOT configurable on any plan. A guide document can hold both
// an EN and FR htmlContent field, so each is budgeted at well under half that
// cap. Content over this threshold is uploaded to Storage instead, and the
// Firestore field holds a download URL (a few hundred bytes) rather than the
// HTML itself.
const INLINE_LIMIT_BYTES = 450_000

// Uploads (or removes) a guide's HTML in Firebase Storage depending on size.
// Returns the pair to write to Firestore: inline content OR a Storage URL,
// with the other always null so stale data from a previous save can't linger.
async function persistGuideHtml(guideId: string, lang: 'en' | 'fr', html: string): Promise<{ inline: string | null; url: string | null }> {
  const path = `guides/${guideId}_${lang}.html`
  const storageRef = ref(storage, path)
  if (!html) {
    // Fire-and-forget: if Storage is unreachable (e.g. billing disabled, no
    // bucket provisioned), the SDK can hang/retry for a long time. There's
    // nothing to clean up in the common case, so don't let this block the save.
    deleteObject(storageRef).catch(() => { /* nothing to clean up, or Storage unavailable */ })
    return { inline: null, url: null }
  }
  const bytes = new Blob([html]).size
  if (bytes <= INLINE_LIMIT_BYTES) {
    // Small enough to inline — best-effort cleanup of any stale Storage object
    // from a previous, larger version of this guide. Same fire-and-forget
    // reasoning as above: a broken Storage bucket must not block an inline save.
    deleteObject(storageRef).catch(() => { /* nothing to clean up, or Storage unavailable */ })
    return { inline: html, url: null }
  }
  await uploadString(storageRef, html, 'raw', { contentType: 'text/html' })
  const url = await getDownloadURL(storageRef)
  return { inline: null, url }
}

const DEFAULT_SITE_META: SiteMeta = {
  title: "Yezi's Knowledge Hub",
  tagline: 'Guides · frameworks · working notes',
  subtitle: 'A personal library of PM tools, frameworks, and operating guides — built to be opened, not just saved.',
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function extractFirstEmoji(text: string): string {
  const match = text.match(/[\u{1F300}-\u{1FAFF}]|[\u{2600}-\u{27BF}]/u)
  return match?.[0] ?? '📄'
}

function parseHtmlMeta(html: string, filename: string): ParsedMeta {
  const parser = new DOMParser()
  const d = parser.parseFromString(html, 'text/html')
  const title = d.querySelector('title')?.textContent?.trim()
    || filename.replace(/\.html?$/i, '').replace(/-/g, ' ')
  const desc =
    d.querySelector('.lede, p.lede, .hero p, .header-desc')?.textContent?.trim()
    || d.querySelector('meta[name="description"]')?.getAttribute('content')
    || d.querySelector('p')?.textContent?.trim().slice(0, 220)
    || ''
  let tag = ''
  const pill = d.querySelector('.pill-label')
  if (pill) {
    const clone = pill.cloneNode(true) as Element
    clone.querySelector('.spark')?.remove()
    tag = clone.textContent?.replace(/✦/g, '').trim() || ''
  }
  if (!tag) tag = d.querySelector('meta[name="keywords"]')?.getAttribute('content') || ''
  const brandText = d.querySelector('.brand-icon, .fire, .mech-icon')?.textContent || ''
  const icon = extractFirstEmoji(brandText) || extractFirstEmoji(d.body.textContent || '') || '📄'
  const chips: string[] = []
  const sectionCount = d.querySelectorAll('section.block, .block').length
  if (sectionCount > 0) chips.push(`${sectionCount} sections`)
  if (d.querySelector('.tpl, pre, .copy-btn')) chips.push('Templates')
  if (html.toLowerCase().includes('playbook')) chips.push('Playbook')
  if (html.toLowerCase().includes('checklist') || d.querySelector('.validate, .vchip')) chips.push('Checklist')
  if (d.querySelector('.matrix, .matrix-row')) chips.push('Framework')
  return { title, description: desc, icon, tag, chips: chips.join(', '), order: 0 }
}

const GLOSSARY = [
  'Continuous Discovery',
  'continuous discovery',
  'Opportunity Solution Tree',
  'opportunity solution tree',
  'Opportunity Solution Trees',
  'opportunity solution trees',
  'Product Manager',
  'Product Managers',
  'product manager',
  'product managers',
  'Product Management',
  'product management',
  'Clay',
  'clay',
  'Output',
  'Outputs',
  'output',
  'outputs',
  'Outcome',
  'Outcomes',
  'outcome',
  'outcomes',
  'Playbook',
  'Playbooks',
  'playbook',
  'playbooks'
]

function protectGlossary(text: string): { protectedText: string; replacements: { placeholder: string; original: string }[] } {
  const replacements: { placeholder: string; original: string }[] = []
  let protectedText = text

  // Sort glossary by length descending to match longer phrases first
  const sortedGlossary = [...GLOSSARY].sort((a, b) => b.length - a.length)

  sortedGlossary.forEach((term, idx) => {
    const escaped = term.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&')
    const regex = new RegExp('\\b' + escaped + '\\b', 'g')
    if (regex.test(protectedText)) {
      const placeholder = `[[[GLOS${idx}]]]`
      replacements.push({ placeholder, original: term })
      protectedText = protectedText.replace(regex, placeholder)
    }
  })

  return { protectedText, replacements }
}

function restoreGlossary(text: string, replacements: { placeholder: string; original: string }[]): string {
  let restoredText = text
  replacements.forEach(({ placeholder, original }) => {
    const escapedPlaceholder = placeholder.replace(/\[/g, '\\[').replace(/\]/g, '\\]')
    const regexStr = escapedPlaceholder.split('GLOS').join('\\s*GLOS\\s*')
    const regex = new RegExp(regexStr, 'gi')
    restoredText = restoredText.replace(regex, original)
  })
  return restoredText
}

// ─── OpenAI gpt-4o-mini translation (primary) ────────────────────────────────
// Sends ALL text segments in ONE API call — full document context, consistent
// PM vocabulary. gpt-4o-mini: best quality/cost for French professional content
// (~$0.30 to translate all 40 guides). Key stored in localStorage only.
//
// OpenAI's API has no CORS headers for browser origins, so it can never be
// called directly from here — this always fails, with any key. Instead this
// routes through the translateTexts Cloud Function, which builds the same
// prompt and makes the same call server-side (no CORS restriction applies
// server-to-server) and just relays the key from this request without
// storing it. See functions/src/index.ts (buildTranslationPrompt, translateTexts).
async function callOpenAITranslate(texts: string[], apiKey: string): Promise<string[]> {
  if (!texts.length || !apiKey) return texts
  const translateFn = httpsCallable<{ texts: string[]; apiKey: string }, { translated: string[] }>(
    getFunctions(), 'translateTexts'
  )
  const result = await translateFn({ texts, apiKey })
  return result.data.translated
}

// Alias so all callers remain unchanged
const callClaudeTranslate = callOpenAITranslate

async function callOpenAIExtractMetadata(htmlContent: string, apiKey: string): Promise<any> {
  if (!htmlContent || !apiKey) return {}
  const extractFn = httpsCallable<{ htmlContent: string; apiKey: string }, { metadataStr: string }>(
    getFunctions(), 'extractMetadata'
  )
  const result = await extractFn({ htmlContent, apiKey })
  try {
    return JSON.parse(result.data.metadataStr)
  } catch (e) {
    console.error('Failed to parse metadata from OpenAI', e)
    return {}
  }
}

// The free Google Translate endpoint is unofficial/undocumented and has no
// SLA — it can hang indefinitely with no response, no error, and no timeout
// of its own. A plain `await fetch(...)` in that situation blocks the entire
// upload flow forever with zero feedback. Give every call to it a hard
// deadline so a slow/unresponsive endpoint degrades to "use the original
// text" instead of hanging the whole guide save.
const TRANSLATE_TIMEOUT_MS = 12_000
function fetchWithTimeout(input: string, init?: RequestInit, timeoutMs = TRANSLATE_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  return fetch(input, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer))
}

async function translateText(text: string | undefined | null, claudeKey?: string): Promise<string> {
  if (!text || typeof text !== 'string' || !text.trim()) return ''
  if (claudeKey) {
    try {
      const [translated] = await callClaudeTranslate([text], claudeKey)
      return translated
    } catch (err) {
      console.warn('OpenRouter translation failed, falling back to Google Translate', err)
    }
  }
  // Google Translate fallback
  const { protectedText, replacements } = protectGlossary(text)
  try {
    const res = await fetchWithTimeout(`https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=fr&dt=t&q=${encodeURIComponent(protectedText)}`)
    const data = await res.json()
    const rawTranslated = data[0].map((item: any) => item[0]).join('')
    return restoreGlossary(rawTranslated, replacements)
  } catch (err) {
    console.error('Translation failed (or timed out) — using original text', err)
    return text
  }
}

// ── Single-call full-guide translation ───────────────────────────────────────
// Collects metadata fields + ALL HTML text nodes → ONE OpenAI API call.
// Reduces from 5-6 sequential calls per guide to 1-2 calls, cutting time by ~5×.
interface GuideTranslated {
  title_fr: string; description_fr: string; tag_fr: string
  chips_fr: string[]; htmlContent_fr: string
}

function collectHtmlTextNodes(htmlString: string): { doc: Document; nodes: Node[]; texts: string[] } {
  const parser = new DOMParser()
  const doc = parser.parseFromString(htmlString, 'text/html')
  const nodes: Node[] = []
  const walk = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement
      if (!parent) return NodeFilter.FILTER_REJECT
      if (['SCRIPT','STYLE','NOSCRIPT','CODE'].includes(parent.tagName.toUpperCase())) return NodeFilter.FILTER_REJECT
      if (!node.nodeValue?.trim()) return NodeFilter.FILTER_REJECT
      return NodeFilter.FILTER_ACCEPT
    }
  })
  let n: Node | null
  while (n = walk.nextNode()) nodes.push(n)
  const titleNode = doc.querySelector('title')
  if (titleNode?.textContent?.trim()) nodes.push(titleNode)
  const texts = nodes.map(n => (n.nodeValue || n.textContent || '').trim())
  return { doc, nodes, texts }
}

// GPT-4o-mini does not reliably preserve a 1:1 segment count when a single
// call is given hundreds of short/fragmentary text segments — it silently
// merges or reformats them instead of respecting the separator, with no
// error and no truncation (`finish_reason: "stop"`), e.g. 736 segments in
// -> only 347 parts back out, corrupting/misaligning most of the guide's
// French content. Batches of 20-50 segments were verified to reliably
// return an exact 1:1 count. To make this self-healing even if a batch
// still mismatches, validate the count and retry recursively at half size.
const SAFE_CHUNK_SIZE = 40

async function translateSegmentsSafe(texts: string[], apiKey: string): Promise<string[]> {
  if (texts.length === 0) return []
  if (texts.length === 1) {
    try {
      const [result] = await callOpenAITranslate(texts, apiKey)
      return [result ?? texts[0]]
    } catch (err) {
      console.warn('[translate] single-segment translation failed, keeping original', err)
      return texts
    }
  }
  if (texts.length > SAFE_CHUNK_SIZE) {
    const mid = Math.ceil(texts.length / 2)
    const [a, b] = await Promise.all([
      translateSegmentsSafe(texts.slice(0, mid), apiKey),
      translateSegmentsSafe(texts.slice(mid), apiKey),
    ])
    return [...a, ...b]
  }
  try {
    const result = await callOpenAITranslate(texts, apiKey)
    if (result.length === texts.length) return result
    console.warn(`[translate] segment count mismatch (sent ${texts.length}, got ${result.length}) — retrying at half size`)
  } catch (err) {
    console.warn('[translate] chunk translation failed — retrying at half size', err)
  }
  const mid = Math.ceil(texts.length / 2)
  const [a, b] = await Promise.all([
    translateSegmentsSafe(texts.slice(0, mid), apiKey),
    translateSegmentsSafe(texts.slice(mid), apiKey),
  ])
  return [...a, ...b]
}

async function translateGuideFull(guide: Guide, apiKey: string): Promise<GuideTranslated> {
  const chipsStr = (guide.chips || []).join(', ')
  const metaFields = [
    guide.title || '',
    guide.description || '',
    guide.tag || '',
    chipsStr,
  ]
  const { doc, nodes, texts: htmlTexts } = collectHtmlTextNodes(guide.htmlContent || '')

  const allTexts = [...metaFields, ...htmlTexts]
  const translated = await translateSegmentsSafe(allTexts, apiKey)

  // Map translated segments back to metadata fields
  const title_fr       = translated[0] || guide.title
  const description_fr = translated[1] || guide.description
  const tag_fr         = translated[2] || guide.tag
  // The model sometimes echoes a separator-like marker around "§" when asked
  // to keep list items distinct, but doesn't reliably reproduce the exact
  // bracket glyphs we asked for (e.g. ⟨§⟩ instead of 〈§〉) — match on § alone,
  // stripping whatever non-comma punctuation/whitespace surrounds it, so any
  // bracket variant is handled instead of just one specific pair.
  const chips_fr       = (translated[3] || chipsStr).replace(/[^\w,]*§[^\w,]*/gu, ',').split(',').map(c => c.trim()).filter(Boolean)
  const htmlTranslated = translated.slice(4)

  // Reassemble HTML
  nodes.forEach((nd, i) => {
    const t = htmlTranslated[i] || ''
    if (!t) return
    if (nd.nodeValue !== null && nd.nodeValue !== undefined) nd.nodeValue = t
    else nd.textContent = t
  })
  const htmlContent_fr = '<!DOCTYPE html>\n' + doc.documentElement.outerHTML

  return { title_fr, description_fr, tag_fr, chips_fr, htmlContent_fr }
}

async function translateHtmlContent(htmlString: string | undefined | null, claudeKey?: string): Promise<string> {
  if (!htmlString || typeof htmlString !== 'string') return ''
  const parser = new DOMParser()
  const doc = parser.parseFromString(htmlString, 'text/html')

  // Collect all translatable text nodes
  const textNodes: Node[] = []
  const walk = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement
      if (!parent) return NodeFilter.FILTER_REJECT
      const tag = parent.tagName.toUpperCase()
      if (['SCRIPT','STYLE','NOSCRIPT','CODE'].includes(tag)) return NodeFilter.FILTER_REJECT
      if (!node.nodeValue?.trim()) return NodeFilter.FILTER_REJECT
      return NodeFilter.FILTER_ACCEPT
    }
  })
  let node: Node | null
  while (node = walk.nextNode()) textNodes.push(node)
  const titleNode = doc.querySelector('title')
  if (titleNode?.textContent?.trim()) textNodes.push(titleNode)
  if (textNodes.length === 0) return htmlString

  const origTexts = textNodes.map(n => (n.nodeValue || n.textContent || '').trim())

  if (claudeKey) {
    // ── OpenAI path — safe-chunked with 1:1 count validation, see
    // translateSegmentsSafe for why a large flat batch isn't reliable ──────
    const allTranslated = await translateSegmentsSafe(origTexts, claudeKey)
    textNodes.forEach((n, i) => {
      const t = allTranslated[i] || origTexts[i]
      if (n.nodeValue !== null && n.nodeValue !== undefined) n.nodeValue = t
      else n.textContent = t
    })
    return '<!DOCTYPE html>\n' + doc.documentElement.outerHTML
  }

  // ── Google Translate fallback (batched, slower) ──────────────────────────
  const batches: Node[][] = []
  let cur: Node[] = [], curLen = 0
  for (const n of textNodes) {
    const v = n.nodeValue || n.textContent || ''
    if (curLen + v.length > 4500 && cur.length) { batches.push(cur); cur = []; curLen = 0 }
    cur.push(n); curLen += v.length
  }
  if (cur.length) batches.push(cur)

  for (let bIdx = 0; bIdx < batches.length; bIdx++) {
    const batch = batches[bIdx]
    const texts = batch.map(n => (n.nodeValue || n.textContent || '').trim())
    const { protectedText, replacements } = protectGlossary(texts.join('\n'))
    try {
      if (bIdx > 0) await new Promise(r => setTimeout(r, 300))
      const formData = new URLSearchParams()
      formData.append('q', protectedText)
      const res = await fetchWithTimeout('https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=fr&dt=t', {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: formData,
      })
      const data = await res.json()
      const lines = restoreGlossary(data[0].map((x: any) => x[0]).join(''), replacements).split('\n')
      batch.forEach((n, i) => {
        const t = lines[i] || texts[i]
        if (n.nodeValue !== null && n.nodeValue !== undefined) n.nodeValue = t
        else n.textContent = t
      })
    } catch (err) { console.error('Batch translation failed', err) }
  }

  return '<!DOCTYPE html>\n' + doc.documentElement.outerHTML
}



// ─── LinkListEditor ──────────────────────────────────────────────────────────

function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 6) }

interface LinkListEditorProps {
  list: LinkList
  sections: Section[]
  isNew: boolean
  onSave: () => void
  onCancel: () => void
  show: (msg: string, type?: 'success' | 'error') => void
}

function LinkListEditor({ list, sections, isNew, onSave, onCancel, show }: LinkListEditorProps) {
  const [title, setTitle] = useState(list.title)
  const [titleFr, setTitleFr] = useState(list.title_fr ?? '')
  const [sectionId, setSectionId] = useState(list.sectionId ?? '')
  const [items, setItems] = useState<LinkItem[]>(
    list.items.length 
      ? list.items.map(it => ({ id: it.id, title: it.title, title_fr: it.title_fr ?? '', url: it.url })) 
      : [{ id: uid(), title: '', title_fr: '', url: '' }]
  )
  const [saving, setSaving] = useState(false)

  function addItem() { setItems(prev => [...prev, { id: uid(), title: '', title_fr: '', url: '' }]) }
  function updateItem(id: string, field: 'title' | 'title_fr' | 'url', val: string) {
    setItems(prev => prev.map(it => it.id === id ? { ...it, [field]: val } : it))
  }
  function removeItem(id: string) { setItems(prev => prev.filter(it => it.id !== id)) }

  async function handleSave() {
    if (!title.trim()) { show('List needs a title.', 'error'); return }
    setSaving(true)
    try {
      const data = {
        title: title.trim(),
        title_fr: titleFr.trim() || null,
        sectionId: sectionId || null,
        order: list.order ?? 0,
        items: items
          .filter(it => it.title.trim() || it.url.trim())
          .map(it => ({ 
            id: it.id, 
            title: it.title.trim(), 
            title_fr: it.title_fr?.trim() || null, 
            url: it.url.trim() 
          })),
      }
      if (isNew) {
        await addDoc(collection(db, 'link_lists'), data)
      } else {
        await updateDoc(doc(db, 'link_lists', list.id), data)
      }
      show(isNew ? 'List created!' : 'List saved!')
      onSave()
    } catch (err) {
      show('Save failed.', 'error'); console.error(err)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="link-list-editor">
      <div style={{ fontSize: 11, fontFamily: 'var(--mono)', color: 'var(--orange-deep)', fontWeight: 700, marginBottom: 14 }}>
        {isNew ? '+ NEW LIST' : `✎ EDITING — ${list.title || 'Untitled list'}`}
      </div>
      <div className="form-grid" style={{ marginBottom: 16 }}>
        <div className="field">
          <label>List title (EN)</label>
          <input value={title} onChange={e => setTitle(e.target.value)} placeholder="e.g. Recommended reads" />
        </div>
        <div className="field">
          <label>List title (FR)</label>
          <input value={titleFr} onChange={e => setTitleFr(e.target.value)} placeholder="e.g. Lectures recommandées" />
        </div>
        <div className="field field-full">
          <label>Section</label>
          <select value={sectionId} onChange={e => setSectionId(e.target.value)}>
            <option value="">— No section (hidden from public) —</option>
            {sections.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>
      </div>

      <div style={{ fontFamily: '"Archivo",sans-serif', fontWeight: 800, fontStyle: 'italic', textTransform: 'uppercase', letterSpacing: '.05em', fontSize: 10.5, color: 'var(--ink-soft)', marginBottom: 10 }}>
        Links
      </div>
      {items.map((item, i) => (
        <div key={item.id} className="link-item-row" style={{ flexWrap: 'wrap', gap: '8px 12px', borderBottom: '1px dashed var(--faint)', paddingBottom: 10, marginBottom: 10 }}>
          <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--muted)', minWidth: 20, alignSelf: 'center' }}>{i + 1}.</span>
          <input
            className="link-item-title"
            value={item.title}
            onChange={e => updateItem(item.id, 'title', e.target.value)}
            placeholder="Link title (EN)"
            style={{ flex: '1 1 180px' }}
          />
          <input
            className="link-item-title"
            value={item.title_fr ?? ''}
            onChange={e => updateItem(item.id, 'title_fr', e.target.value)}
            placeholder="Link title (FR)"
            style={{ flex: '1 1 180px' }}
          />
          <input
            className="link-item-url"
            value={item.url}
            onChange={e => updateItem(item.id, 'url', e.target.value)}
            placeholder="https://"
            type="url"
            style={{ flex: '2 1 240px' }}
          />
          <button type="button" className="btn btn-danger btn-sm" onClick={() => removeItem(item.id)}
            style={{ flexShrink: 0, alignSelf: 'center' }}>✕</button>
        </div>
      ))}
      <button type="button" onClick={addItem}
        style={{ fontFamily: 'var(--mono)', fontSize: 12, padding: '5px 13px', border: '1.5px dashed var(--faint)', borderRadius: 8, cursor: 'pointer', background: 'var(--paper)', color: 'var(--muted)', marginBottom: 16 }}>
        + Add link
      </button>

      <div style={{ display: 'flex', gap: 10 }}>
        <button type="button" className="btn btn-primary btn-sm" onClick={handleSave} disabled={saving}>
          {saving ? 'Saving…' : '💾 Save list'}
        </button>
        <button type="button" className="btn btn-secondary btn-sm" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  )
}

// ─── PlaylistEditor (Learning Paths) ─────────────────────────────────────────

interface PlaylistEditorProps {
  playlist: Playlist
  guides: Guide[]
  isNew: boolean
  onSave: () => void
  onCancel: () => void
  show: (msg: string, type?: 'success' | 'error') => void
}

function PlaylistEditor({ playlist, guides, isNew, onSave, onCancel, show }: PlaylistEditorProps) {
  const [title, setTitle] = useState(playlist.title)
  const [titleFr, setTitleFr] = useState(playlist.title_fr ?? '')
  const [description, setDescription] = useState(playlist.description)
  const [descriptionFr, setDescriptionFr] = useState(playlist.description_fr ?? '')
  const [icon, setIcon] = useState(playlist.icon || '🎯')
  const [published, setPublished] = useState(playlist.published ?? false)
  const [guideIds, setGuideIds] = useState<string[]>(playlist.guideIds ?? [])
  const [addGuideId, setAddGuideId] = useState('')
  const [saving, setSaving] = useState(false)

  const availableGuides = guides.filter(g => !guideIds.includes(g.id))
  const pickedGuides = guideIds.map(id => guides.find(g => g.id === id)).filter((g): g is Guide => !!g)

  function addGuide() {
    if (!addGuideId) return
    setGuideIds(prev => [...prev, addGuideId])
    setAddGuideId('')
  }
  function removeGuide(id: string) { setGuideIds(prev => prev.filter(gid => gid !== id)) }
  function moveGuide(idx: number, dir: -1 | 1) {
    setGuideIds(prev => {
      const next = [...prev]
      const target = idx + dir
      if (target < 0 || target >= next.length) return next
      ;[next[idx], next[target]] = [next[target], next[idx]]
      return next
    })
  }

  async function handleSave() {
    if (!title.trim()) { show('Learning path needs a title.', 'error'); return }
    if (guideIds.length === 0) { show('Add at least one guide.', 'error'); return }
    setSaving(true)
    try {
      const data = {
        title: title.trim(),
        title_fr: titleFr.trim() || null,
        description: description.trim(),
        description_fr: descriptionFr.trim() || null,
        icon: icon.trim() || '🎯',
        order: playlist.order ?? 0,
        published,
        guideIds,
      }
      if (isNew) {
        await addDoc(collection(db, 'playlists'), data)
      } else {
        await updateDoc(doc(db, 'playlists', playlist.id), data)
      }
      show(isNew ? 'Learning path created!' : 'Learning path saved!')
      onSave()
    } catch (err) {
      show('Save failed.', 'error'); console.error(err)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="link-list-editor">
      <div style={{ fontSize: 11, fontFamily: 'var(--mono)', color: 'var(--orange-deep)', fontWeight: 700, marginBottom: 14 }}>
        {isNew ? '+ NEW LEARNING PATH' : `✎ EDITING — ${playlist.title || 'Untitled path'}`}
      </div>
      <div className="form-grid" style={{ marginBottom: 16 }}>
        <div className="field">
          <label>Icon</label>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <EmojiPicker value={icon} onChange={setIcon} />
            <input value={icon} onChange={e => setIcon(e.target.value)} style={{ flex: 1 }} placeholder="or type any emoji" />
          </div>
        </div>
        <div className="field">
          <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input type="checkbox" checked={published} onChange={e => setPublished(e.target.checked)} />
            Published (visible on public site)
          </label>
        </div>
        <div className="field">
          <label>Title (EN)</label>
          <input value={title} onChange={e => setTitle(e.target.value)} placeholder="e.g. Zero to First PRD" />
        </div>
        <div className="field">
          <label>Title (FR)</label>
          <input value={titleFr} onChange={e => setTitleFr(e.target.value)} placeholder="e.g. De zéro à votre premier PRD" />
        </div>
        <div className="field field-full">
          <label>Description (EN)</label>
          <textarea value={description} onChange={e => setDescription(e.target.value)} placeholder="What will a reader get out of following this path?" />
        </div>
        <div className="field field-full">
          <label>Description (FR)</label>
          <textarea value={descriptionFr} onChange={e => setDescriptionFr(e.target.value)} />
        </div>
      </div>

      <div style={{ fontFamily: '"Archivo",sans-serif', fontWeight: 800, fontStyle: 'italic', textTransform: 'uppercase', letterSpacing: '.05em', fontSize: 10.5, color: 'var(--ink-soft)', marginBottom: 10 }}>
        Guides in order
      </div>
      {pickedGuides.length === 0 && (
        <div className="empty-state" style={{ marginTop: 0, marginBottom: 12 }}>
          <span className="icon">📭</span>
          <p>No guides added yet — pick one below.</p>
        </div>
      )}
      {pickedGuides.map((g, i) => (
        <div key={g.id} className="link-item-row" style={{ flexWrap: 'wrap', gap: '8px 12px', borderBottom: '1px dashed var(--faint)', paddingBottom: 10, marginBottom: 10, alignItems: 'center' }}>
          <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--muted)', minWidth: 20 }}>{i + 1}.</span>
          <span style={{ fontSize: 16 }}>{g.icon}</span>
          <span style={{ flex: '1 1 240px' }}>{g.title}</span>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => moveGuide(i, -1)} disabled={i === 0}>↑</button>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => moveGuide(i, 1)} disabled={i === pickedGuides.length - 1}>↓</button>
          <button type="button" className="btn btn-danger btn-sm" onClick={() => removeGuide(g.id)}>✕</button>
        </div>
      ))}
      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <select value={addGuideId} onChange={e => setAddGuideId(e.target.value)} style={{ flex: 1 }}>
          <option value="">— Pick a guide to add —</option>
          {availableGuides.map(g => <option key={g.id} value={g.id}>{g.icon} {g.title}</option>)}
        </select>
        <button type="button" className="btn btn-secondary btn-sm" onClick={addGuide} disabled={!addGuideId}>+ Add</button>
      </div>

      <div style={{ display: 'flex', gap: 10 }}>
        <button type="button" className="btn btn-primary btn-sm" onClick={handleSave} disabled={saving}>
          {saving ? 'Saving…' : '💾 Save learning path'}
        </button>
        <button type="button" className="btn btn-secondary btn-sm" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  )
}

// ─── EmojiPicker ─────────────────────────────────────────────────────────────

const EMOJI_OPTIONS = [
  '📋','📊','📈','📉','📄','📝','✅','🎯','🏆','💡','🔧','⚙️',
  '🔑','🛠','📚','📖','🎓','🧠','📐','📏','🔬','💭','🗂','📁',
  '💼','🤝','💰','🏢','🌐','📣','🎤','📢','🎨','✏️','🖊','🖋',
  '🖼','🎬','💻','🖥','📱','🔌','💾','🛡','🔐','💬','📞','📧',
  '📨','🗣','📡','🌱','🌟','⭐','🚀','🔥','💪','🎉','🌊','⚡',
]

interface EmojiPickerProps { value: string; onChange: (emoji: string) => void }

function EmojiPicker({ value, onChange }: EmojiPickerProps) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function onOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onOutside)
    return () => document.removeEventListener('mousedown', onOutside)
  }, [open])

  return (
    <div ref={ref} style={{ position: 'relative', display: 'inline-block', flexShrink: 0 }}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        title="Pick an emoji"
        style={{
          fontSize: 22, lineHeight: 1, padding: '3px 8px',
          border: '2px solid var(--line)', borderRadius: 8,
          background: open ? 'var(--orange-soft)' : 'var(--paper)',
          cursor: 'pointer', minWidth: 44, textAlign: 'center',
        }}
      >
        {value || '📄'}
      </button>
      {open && (
        <div style={{
          position: 'absolute', top: 'calc(100% + 4px)', left: 0, zIndex: 300,
          background: 'var(--paper)', border: '2px solid var(--line)', borderRadius: 12,
          padding: 8, display: 'grid', gridTemplateColumns: 'repeat(8, 1fr)',
          gap: 2, width: 256, boxShadow: '3px 3px 0 rgba(0,0,0,0.12)',
        }}>
          {EMOJI_OPTIONS.map(em => (
            <button
              key={em} type="button"
              onClick={() => { onChange(em); setOpen(false) }}
              style={{
                fontSize: 18, lineHeight: 1, padding: 4, border: 'none',
                borderRadius: 6, cursor: 'pointer', textAlign: 'center',
                background: value === em ? 'var(--orange-soft)' : 'transparent',
              }}
              onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = 'var(--orange-soft)' }}
              onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = value === em ? 'var(--orange-soft)' : 'transparent' }}
            >
              {em}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── SectionRow ──────────────────────────────────────────────────────────────

interface SectionRowProps {
  section: Section
  idx: number
  isDragging: boolean
  isDropTarget: boolean
  dropAbove: boolean
  onUpdate: (name: string, intro: string, nameFr: string, introFr: string) => void
  onMegaGroupChange: (megaGroup: string) => void
  onDelete: () => void
  onDragStart: () => void
}

function SectionRow({ section, idx, isDragging, isDropTarget, dropAbove, onUpdate, onMegaGroupChange, onDelete, onDragStart }: SectionRowProps) {
  const [name, setName] = useState(section.name)
  const [nameFr, setNameFr] = useState(section.name_fr ?? '')
  const [intro, setIntro] = useState(section.intro ?? '')
  const [introFr, setIntroFr] = useState(section.intro_fr ?? '')
  const dirty = name !== section.name || nameFr !== (section.name_fr ?? '') || intro !== (section.intro ?? '') || introFr !== (section.intro_fr ?? '')

  return (
    <div
      className="section-row"
      draggable={true}
      data-drag-idx={idx}
      onDragStart={onDragStart}
      style={{
        opacity: isDragging ? 0.3 : 1,
        borderTop: isDropTarget && dropAbove ? '3px solid var(--orange)' : '1.5px solid var(--line)',
        borderBottom: isDropTarget && !dropAbove ? '3px solid var(--orange)' : undefined,
        transition: 'opacity .12s',
        flexDirection: 'column',
        alignItems: 'stretch',
        gap: 8,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div className="drag-handle" title="Drag to reorder">⠿</div>
        <div className="section-inputs" style={{ flex: 1 }}>
          <input
            className="section-name-input"
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="Section name (EN)"
            draggable={false}
            onMouseDown={e => e.stopPropagation()}
          />
          <input
            className="section-intro-input"
            value={intro}
            onChange={e => setIntro(e.target.value)}
            placeholder="Short intro for visitors (EN) (optional)"
            draggable={false}
            onMouseDown={e => e.stopPropagation()}
          />
        </div>
        <div className="section-actions">
          <select
            value={section.megaGroup || ''}
            onChange={e => onMegaGroupChange(e.target.value)}
            title="Mega-group"
            style={{
              fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 600,
              padding: '5px 20px 5px 8px', border: '1.5px solid var(--line)', borderRadius: 7,
              background: 'var(--cream)', cursor: 'pointer',
            }}
          >
            <option value="">— mega-group —</option>
            {MEGA_GROUPS.map(g => <option key={g} value={g}>{g}</option>)}
          </select>
          {dirty && (
            <button className="btn btn-primary btn-sm" onClick={() => onUpdate(name, intro, nameFr, introFr)}>Save</button>
          )}
          <button className="btn btn-danger btn-sm" onClick={onDelete}>Delete</button>
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, paddingLeft: 28 }}>
        <div className="section-inputs" style={{ flex: 1 }}>
          <input
            className="section-name-input"
            value={nameFr}
            onChange={e => setNameFr(e.target.value)}
            placeholder="Section name (FR)"
            draggable={false}
            onMouseDown={e => e.stopPropagation()}
          />
          <input
            className="section-intro-input"
            value={introFr}
            onChange={e => setIntroFr(e.target.value)}
            placeholder="Short intro for visitors (FR) (optional)"
            draggable={false}
            onMouseDown={e => e.stopPropagation()}
          />
        </div>
        <div style={{ width: 114 }} /> {/* align action spacer */}
      </div>
    </div>
  )
}

// ─── EditPanel ───────────────────────────────────────────────────────────────

interface EditPanelProps {
  guide: Guide
  sections: Section[]
  onSave: () => void
  onCancel: () => void
  show: (msg: string, type?: 'success' | 'error') => void
  openAIKey?: string
}

function EditPanel({ guide, sections, onSave, onCancel, show, openAIKey }: EditPanelProps) {
  const [form, setForm] = useState({
    title: guide.title,
    description: guide.description,
    icon: guide.icon,
    tag: guide.tag,
    chips: Array.isArray(guide.chips) ? guide.chips.join(', ') : '',
    level: guide.level ?? '',
    order: guide.order ?? 0,
    sectionId: guide.sectionId ?? '',

    // French metadata
    title_fr: guide.title_fr ?? '',
    description_fr: guide.description_fr ?? '',
    tag_fr: guide.tag_fr ?? '',
    chips_fr: Array.isArray(guide.chips_fr) ? guide.chips_fr.join(', ') : '',
    level_fr: guide.level_fr ?? '',
  })
  
  const [editedHtml, setEditedHtml] = useState(guide.htmlContent)
  const [editedHtmlFr, setEditedHtmlFr] = useState(guide.htmlContent_fr ?? '')
  const [htmlTab, setHtmlTab] = useState<'visual' | 'source'>('visual')
  const [activeTab, setActiveTab] = useState<'en' | 'fr'>('en')
  
  const [newFile, setNewFile] = useState<File | null>(null)
  const [newFileFr, setNewFileFr] = useState<File | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const [saving, setSaving] = useState(false)
  const [translating, setTranslating] = useState(false)
  const [showImageEditor, setShowImageEditor] = useState(false)
  
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const fileInputFrRef = useRef<HTMLInputElement>(null)

  function insertImageIntoIframe(html: string) {
    const idoc = iframeRef.current?.contentDocument
    if (!idoc) return
    idoc.body.focus()
    idoc.execCommand('insertHTML', false, html)
    setShowImageEditor(false)
  }

  useEffect(() => {
    if (htmlTab !== 'visual') return
    function handleKey(e: KeyboardEvent) {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'z') return
      const idoc = iframeRef.current?.contentDocument
      if (!idoc) return
      e.preventDefault()
      idoc.execCommand(e.shiftKey ? 'redo' : 'undo')
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [htmlTab])

  function handleIframeLoad() {
    const _doc = iframeRef.current?.contentDocument
    if (!_doc) return
    const doc: Document = _doc
    doc.designMode = 'on'

    const style = doc.createElement('style')
    style.id = '__wysiwyg_injected__'
    style.textContent = `
      body { cursor: text; }
      *:hover { outline: 1.5px dashed rgba(207,125,40,0.30) !important; }
      #__tb__ {
        display: none; position: fixed; z-index: 99999;
        background: #1c1814; border-radius: 11px; padding: 5px 8px;
        gap: 2px; align-items: center;
        box-shadow: 3px 3px 0 rgba(0,0,0,0.55);
        white-space: nowrap; top: 0; left: 0;
        font-family: -apple-system, BlinkMacSystemFont, "Inter", sans-serif;
      }
      #__tb__.on { display: flex; }
      #__tb__ button {
        background: transparent; border: none; color: #fff;
        font-size: 13px; min-width: 26px; height: 26px;
        border-radius: 6px; cursor: pointer;
        display: flex; align-items: center; justify-content: center;
        padding: 0 5px; font-family: inherit; transition: background .1s;
      }
      #__tb__ button:hover { background: rgba(255,255,255,0.18); }
      #__tb__ .sep { width: 1px; height: 16px; background: rgba(255,255,255,0.18); margin: 0 3px; flex-shrink: 0; }
      #__tb__ #__link_input__ { display: none; align-items: center; gap: 5px; }
      #__tb__ #__link_input__.on { display: flex; }
      #__tb__ #__link_input__ input {
        background: rgba(255,255,255,0.12); border: 1px solid rgba(255,255,255,0.3);
        border-radius: 5px; color: #fff; font-size: 12px; padding: 3px 7px; width: 180px; outline: none;
      }
      #__tb__ #__link_input__ button { font-size: 12px; padding: 0 8px; background: #e8943a; }
    `
    doc.head.appendChild(style)

    const tb = doc.createElement('div')
    tb.id = '__tb__'
    tb.innerHTML = `
      <button data-cmd="undo" title="Undo (⌘Z)" style="font-size:14px">↩</button>
      <button data-cmd="redo" title="Redo (⌘⇧Z)" style="font-size:14px">↪</button>
      <div class="sep"></div>
      <button data-cmd="bold" title="Bold"><b>B</b></button>
      <button data-cmd="italic" title="Italic"><i>I</i></button>
      <button data-cmd="underline" title="Underline"><u>U</u></button>
      <button data-cmd="strikeThrough" title="Strikethrough"><s>S</s></button>
      <div class="sep"></div>
      <button data-cmd="link" title="Link">🔗</button>
      <div class="sep"></div>
      <button data-cmd="insertOrderedList" title="Numbered list" style="font-size:11px">1≡</button>
      <button data-cmd="insertUnorderedList" title="Bullet list" style="font-size:14px">•≡</button>
      <button data-cmd="indent" title="Indent" style="font-size:12px">|≡</button>
      <div class="sep"></div>
      <button data-cmd="code" title="Inline code" style="font-size:11px">&lt;/&gt;</button>
      <button data-cmd="removeFormat" title="Clear formatting" style="font-size:11px">✕fmt</button>
      <div id="__link_input__">
        <input id="__link_url__" type="url" placeholder="https://" />
        <button data-cmd="applyLink">✓</button>
        <button data-cmd="cancelLink">✕</button>
      </div>
    `
    doc.body.appendChild(tb)

    let savedRange: Range | null = null
    function saveRange() {
      const sel = doc.getSelection()
      if (sel && sel.rangeCount > 0) savedRange = sel.getRangeAt(0).cloneRange()
    }
    function restoreRange() {
      if (!savedRange) return
      const sel = doc.getSelection()
      sel?.removeAllRanges()
      sel?.addRange(savedRange)
    }
    function positionToolbar() {
      const sel = doc.getSelection()
      if (!sel || sel.isCollapsed || !sel.rangeCount) { tb.classList.remove('on'); return }
      const rect = sel.getRangeAt(0).getBoundingClientRect()
      if (!rect.width) { tb.classList.remove('on'); return }
      saveRange()
      tb.classList.add('on')
      const tbW = tb.offsetWidth || 320
      const x = Math.max(8, rect.left + rect.width / 2 - tbW / 2)
      const y = Math.max(8, rect.top - tb.offsetHeight - 8)
      tb.style.left = x + 'px'
      tb.style.top = y + 'px'
    }
    doc.addEventListener('selectionchange', () => {
      const linkRow = doc.getElementById('__link_input__')!
      if (linkRow.classList.contains('on')) return
      positionToolbar()
    })
    tb.addEventListener('mousedown', (e: Event) => {
      e.preventDefault()
      const btn = (e.target as HTMLElement).closest('[data-cmd]') as HTMLElement | null
      if (!btn) return
      const cmd = btn.dataset.cmd!
      const linkRow = doc.getElementById('__link_input__')!
      const linkInput = doc.getElementById('__link_url__') as HTMLInputElement
      restoreRange()
      if (cmd === 'link') {
        const parentA = doc.getSelection()?.anchorNode?.parentElement?.closest('a')
        if (parentA) { doc.execCommand('unlink', false); return }
        linkRow.classList.add('on')
        linkInput.value = ''
        linkInput.focus()
        return
      }
      if (cmd === 'applyLink') {
        restoreRange()
        const url = linkInput.value.trim()
        if (url) doc.execCommand('createLink', false, url)
        linkRow.classList.remove('on')
        return
      }
      if (cmd === 'cancelLink') { linkRow.classList.remove('on'); return }
      if (cmd === 'code') {
        const sel = doc.getSelection()
        if (!sel || sel.isCollapsed) return
        const range = sel.getRangeAt(0)
        const parent = range.commonAncestorContainer.parentElement
        if (parent?.tagName === 'CODE') {
          parent.replaceWith(doc.createTextNode(parent.textContent || ''))
          return
        }
        const code = doc.createElement('code')
        code.style.cssText = 'font-family:monospace;background:#f0ebe3;padding:1px 5px;border-radius:4px;font-size:0.9em'
        range.surroundContents(code)
        return
      }
      doc.execCommand(cmd, false)
    })
  }

  function syncFromIframe(): string {
    const idoc = iframeRef.current?.contentDocument
    if (!idoc) return activeTab === 'en' ? editedHtml : editedHtmlFr
    idoc.getElementById('__wysiwyg_injected__')?.remove()
    idoc.getElementById('__tb__')?.remove()
    return '<!DOCTYPE html>\n' + idoc.documentElement.outerHTML
  }

  function handleTabSwitch(tab: 'visual' | 'source') {
    if (htmlTab === 'visual') {
      const synced = syncFromIframe()
      if (activeTab === 'en') {
        setEditedHtml(synced)
      } else {
        setEditedHtmlFr(synced)
      }
    }
    setHtmlTab(tab)
  }

  function switchTab(newTab: 'en' | 'fr') {
    if (htmlTab === 'visual') {
      const synced = syncFromIframe()
      if (activeTab === 'en') {
        setEditedHtml(synced)
      } else {
        setEditedHtmlFr(synced)
      }
    }
    setActiveTab(newTab)
  }

  async function handleDropFile(f: File) {
    if (!f.name.endsWith('.html')) { show('Only .html files.', 'error'); return }
    if (f.size > MAX_SIZE_BYTES) { show('File too large.', 'error'); return }
    const content = await f.text()
    setNewFile(f)
    setEditedHtml(content)
    
    const meta = parseHtmlMeta(content, f.name)
    const key = openAIKey || undefined
    show(key ? 'Auto-translating guide content and metadata to French (GPT-4o-mini)...' : 'Auto-translating guide content and metadata to French (Google Translate)...')
    try {
      const translatedHtml = await translateHtmlContent(content, key)
      setEditedHtmlFr(translatedHtml)

      const [title_fr, description_fr, tag_fr, chips_fr] = await Promise.all([
        translateText(meta.title, key),
        translateText(meta.description, key),
        translateText(meta.tag, key),
        translateText(meta.chips, key),
      ])
      
      setForm(prev => ({ 
        ...prev, 
        title: meta.title,
        description: meta.description,
        icon: meta.icon,
        tag: meta.tag,
        chips: meta.chips,
        
        title_fr,
        description_fr,
        tag_fr,
        chips_fr,
      }))
      show('French translation generated successfully!')
    } catch (err) {
      setForm(prev => ({ 
        ...prev, 
        title: meta.title,
        description: meta.description,
        icon: meta.icon,
        tag: meta.tag,
        chips: meta.chips,
      }))
      show('File loaded. French translation failed.', 'error')
      console.error(err)
    }
  }

  async function handleDropFileFr(f: File) {
    if (!f.name.endsWith('.html')) { show('Only .html files.', 'error'); return }
    if (f.size > MAX_SIZE_BYTES) { show('File too large.', 'error'); return }
    const content = await f.text()
    setEditedHtmlFr(content)
    setNewFileFr(f)
    show('French HTML file loaded!')
  }

  async function handleAutoTranslate() {
    setTranslating(true)
    const key = openAIKey || undefined
    show(key ? 'Translating metadata to French (GPT-4o-mini)...' : 'Translating metadata to French (Google Translate)...')
    try {
      const [title_fr, description_fr, tag_fr, chips_fr] = await Promise.all([
        translateText(form.title, key),
        translateText(form.description, key),
        translateText(form.tag, key),
        translateText(form.chips, key).then(res => res.replace(/[{<〈\[(]?§[}>〉\])]?/g, ',')),
      ])
      setForm(prev => ({
        ...prev,
        title_fr,
        description_fr,
        tag_fr,
        chips_fr,
      }))
      show('Metadata auto-translated!')
    } catch (err) {
      show('Auto-translation failed.', 'error')
      console.error(err)
    } finally {
      setTranslating(false)
    }
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    
    // Sync current tab content
    const finalHtml = htmlTab === 'visual' ? syncFromIframe() : (activeTab === 'en' ? editedHtml : editedHtmlFr)
    let enHtml = editedHtml
    let frHtml = editedHtmlFr
    if (activeTab === 'en') {
      enHtml = finalHtml
    } else {
      frHtml = finalHtml
    }

    try {
      const [en, fr] = await Promise.all([
        persistGuideHtml(guide.id, 'en', enHtml),
        persistGuideHtml(guide.id, 'fr', frHtml.trim()),
      ])
      const update: Record<string, any> = {
        title: form.title.trim(),
        description: form.description.trim(),
        icon: form.icon.trim() || '📄',
        tag: form.tag.trim(),
        chips: form.chips.split(',').map(c => c.trim()).filter(Boolean),
        level: form.level || null,
        order: Number(form.order) || 0,
        sectionId: form.sectionId || null,
        htmlContent: en.inline,
        htmlUrl: en.url,

        // French translations
        title_fr: form.title_fr.trim() || null,
        description_fr: form.description_fr.trim() || null,
        tag_fr: form.tag_fr.trim() || null,
        chips_fr: form.chips_fr.replace(/[{<〈\[(]?§[}>〉\])]?/g, ',').split(',').map((c: string) => c.trim()).filter(Boolean),
        level_fr: form.level_fr || null,
        htmlContent_fr: fr.inline,
        htmlUrl_fr: fr.url,
      }
      if (newFile) update.filename = newFile.name
      if (newFileFr) update.filename_fr = newFileFr.name

      await updateDoc(doc(db, 'guides', guide.id), update)
      show('Saved!')
      onSave()
    } catch (err) {
      show('Save failed.', 'error')
      console.error(err)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div style={{
      background: 'var(--orange-soft)', border: '2px solid var(--line)',
      borderRadius: 14, padding: '20px 20px 16px', marginTop: 8
    }}>
      <div style={{ fontSize: 11, fontFamily: 'var(--mono)', color: 'var(--orange-deep)', fontWeight: 700, marginBottom: 14 }}>
        ✎ EDITING — {guide.filename}
      </div>

      <div className="editor-tabs">
        <button type="button" className={`editor-tab-btn ${activeTab === 'en' ? 'active' : ''}`} onClick={() => switchTab('en')}>English</button>
        <button type="button" className={`editor-tab-btn ${activeTab === 'fr' ? 'active' : ''}`} onClick={() => switchTab('fr')}>French (Français)</button>
        <button type="button" className="btn btn-secondary btn-sm" style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center' }} onClick={handleAutoTranslate} disabled={translating}>
          {translating ? 'Translating…' : '✨ Auto-translate EN → FR'}
        </button>
      </div>

      <form onSubmit={handleSave}>
        {activeTab === 'en' ? (
          <div className="form-grid">
            <div className="field field-full">
              <label>Title (EN)</label>
              <input value={form.title} onChange={e => setForm(f => ({ ...f, title: e.target.value }))} required />
            </div>
            <div className="field field-full">
              <label>Description (EN)</label>
              <textarea value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} />
            </div>
            <div className="field">
              <label>Icon</label>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <EmojiPicker value={form.icon} onChange={v => setForm(f => ({ ...f, icon: v }))} />
                <input value={form.icon} onChange={e => setForm(f => ({ ...f, icon: e.target.value }))} style={{ flex: 1 }} placeholder="or type any emoji" />
              </div>
            </div>
            <div className="field">
              <label>Content type (EN)</label>
              <select value={form.tag} onChange={e => setForm(f => ({ ...f, tag: e.target.value }))}>
                <option value="">— none —</option>
                {CONTENT_TYPES.map(t => <option key={t.en} value={t.en}>{t.en}</option>)}
              </select>
            </div>
            <div className="field">
              <label>Level</label>
              <select value={form.level} onChange={e => setForm(f => ({ ...f, level: e.target.value }))}>
                <option value="">— none —</option>
                {LEVELS.map(l => <option key={l.en} value={l.en}>{l.en}</option>)}
              </select>
            </div>
            <div className="field field-full">
              <label>Section</label>
              <select value={form.sectionId} onChange={e => setForm(f => ({ ...f, sectionId: e.target.value }))}>
                <option value="">— No section (hidden from public) —</option>
                {sections.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
            <div className="field">
              <label>Chips (EN) (comma-separated)</label>
              <input value={form.chips} onChange={e => setForm(f => ({ ...f, chips: e.target.value }))} />
            </div>
            <div className="field">
              <label>Sort order</label>
              <input type="number" value={form.order} onChange={e => setForm(f => ({ ...f, order: Number(e.target.value) }))} />
            </div>
          </div>
        ) : (
          <div className="form-grid">
            <div className="field field-full">
              <label>Title (FR)</label>
              <input value={form.title_fr} onChange={e => setForm(f => ({ ...f, title_fr: e.target.value }))} placeholder="Traduction du titre" />
            </div>
            <div className="field field-full">
              <label>Description (FR)</label>
              <textarea value={form.description_fr} onChange={e => setForm(f => ({ ...f, description_fr: e.target.value }))} placeholder="Traduction de la description" />
            </div>
            <div className="field">
              <label>Content type (FR)</label>
              <select value={form.tag_fr} onChange={e => setForm(f => ({ ...f, tag_fr: e.target.value }))}>
                <option value="">— none —</option>
                {CONTENT_TYPES.map(t => <option key={t.fr} value={t.fr}>{t.fr}</option>)}
              </select>
            </div>
            <div className="field">
              <label>Level (FR)</label>
              <select value={form.level_fr} onChange={e => setForm(f => ({ ...f, level_fr: e.target.value }))}>
                <option value="">— none —</option>
                {LEVELS.map(l => <option key={l.fr} value={l.fr}>{l.fr}</option>)}
              </select>
            </div>
            <div className="field">
              <label>Chips (FR) (comma-separated)</label>
              <input value={form.chips_fr} onChange={e => setForm(f => ({ ...f, chips_fr: e.target.value }))} placeholder="Mots-clés en français" />
            </div>
          </div>
        )}

        {/* Content editor */}
        <div style={{ marginBottom: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
            <label style={{ fontFamily: '"Archivo",sans-serif', fontWeight: 800, fontStyle: 'italic', textTransform: 'uppercase', letterSpacing: '.05em', fontSize: 10.5, color: 'var(--ink-soft)', marginRight: 4 }}>
              Content ({activeTab === 'en' ? 'English' : 'French'})
            </label>
            {(['visual', 'source'] as const).map(tab => (
              <button key={tab} type="button" onClick={() => handleTabSwitch(tab)}
                style={{
                  fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 700,
                  padding: '4px 13px', border: '2px solid var(--line)', borderRadius: 7, cursor: 'pointer',
                  background: htmlTab === tab ? 'var(--ink)' : 'var(--paper)',
                  color: htmlTab === tab ? '#fff' : 'var(--ink-soft)',
                }}>
                {tab === 'visual' ? '✏️ Visual editor' : '</> Source'}
              </button>
            ))}
            {htmlTab === 'visual' && (
              <>
                <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--muted)', marginLeft: 4 }}>
                  Click any text to edit · orange outline = editable
                </span>
                <button type="button" onClick={() => setShowImageEditor(true)}
                  style={{
                    fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 700,
                    padding: '4px 11px', border: '2px solid var(--line)', borderRadius: 7, cursor: 'pointer',
                    background: 'var(--paper)', color: 'var(--ink)', display: 'flex', alignItems: 'center', gap: 5,
                  }}>
                  🖼 Insert image
                </button>
              </>
            )}

            {activeTab === 'en' ? (
              <div
                className={`dropzone${dragOver ? ' drag-over' : ''}`}
                style={{ marginLeft: 'auto', flex: '0 0 auto', padding: '5px 14px', display: 'flex', alignItems: 'center', gap: 8, marginBottom: 0, minHeight: 'unset' }}
                onClick={() => fileInputRef.current?.click()}
                onDragOver={e => { e.preventDefault(); setDragOver(true) }}
                onDragLeave={() => setDragOver(false)}
                onDrop={e => { e.preventDefault(); setDragOver(false); const f = e.dataTransfer.files[0]; if (f) handleDropFile(f) }}
              >
                <span style={{ fontSize: 14 }}>{newFile ? '✅' : '📂'}</span>
                <span style={{ fontSize: 12, color: 'var(--muted)' }}>
                  {newFile ? `${newFile.name} loaded` : 'Drop EN .html to replace'}
                </span>
              </div>
            ) : (
              <div
                className={`dropzone${dragOver ? ' drag-over' : ''}`}
                style={{ marginLeft: 'auto', flex: '0 0 auto', padding: '5px 14px', display: 'flex', alignItems: 'center', gap: 8, marginBottom: 0, minHeight: 'unset' }}
                onClick={() => fileInputFrRef.current?.click()}
                onDragOver={e => { e.preventDefault(); setDragOver(true) }}
                onDragLeave={() => setDragOver(false)}
                onDrop={e => { e.preventDefault(); setDragOver(false); const f = e.dataTransfer.files[0]; if (f) handleDropFileFr(f) }}
              >
                <span style={{ fontSize: 14 }}>{newFileFr ? '✅' : '📂'}</span>
                <span style={{ fontSize: 12, color: 'var(--muted)' }}>
                  {newFileFr ? `${newFileFr.name} loaded` : 'Drop FR .html translation'}
                </span>
              </div>
            )}
            <input ref={fileInputRef} type="file" accept=".html" className="dz-input"
              onChange={e => { const f = e.target.files?.[0]; if (f) handleDropFile(f) }} />
            <input ref={fileInputFrRef} type="file" accept=".html" className="dz-input"
              onChange={e => { const f = e.target.files?.[0]; if (f) handleDropFileFr(f) }} />
          </div>

          {htmlTab === 'visual' ? (
            <iframe
              ref={iframeRef}
              key={`${activeTab}-${(activeTab === 'en' ? editedHtml : editedHtmlFr).length}`}
              srcDoc={activeTab === 'en' ? editedHtml : (editedHtmlFr || editedHtml)}
              title="visual-editor"
              onLoad={handleIframeLoad}
              sandbox="allow-scripts allow-same-origin"
              style={{ width: '100%', height: 520, border: '2px solid var(--orange)', borderRadius: 10, background: '#fff' }}
            />
          ) : (
            <textarea
              value={activeTab === 'en' ? editedHtml : editedHtmlFr}
              onChange={e => {
                if (activeTab === 'en') {
                  setEditedHtml(e.target.value)
                } else {
                  setEditedHtmlFr(e.target.value)
                }
              }}
              spellCheck={false}
              style={{
                width: '100%', height: 360, padding: '12px 14px',
                fontFamily: 'var(--mono)', fontSize: 12, lineHeight: 1.6,
                border: '2px solid var(--line)', borderRadius: 10,
                background: 'var(--ink)', color: '#e8e0d5',
                resize: 'vertical', outline: 'none',
              }}
            />
          )}
        </div>

        <div style={{ display: 'flex', gap: 10 }}>
          <button type="submit" className="btn btn-primary btn-sm" disabled={saving}>
            {saving ? 'Saving…' : '💾 Save changes'}
          </button>
          <button type="button" className="btn btn-secondary btn-sm" onClick={onCancel}>Cancel</button>
        </div>
      </form>

      {showImageEditor && (
        <ImageEditorModal
          onInsert={insertImageIntoIframe}
          onClose={() => setShowImageEditor(false)}
        />
      )}
    </div>
  )
}

// ─── Duplicate content detection ──────────────────────────────────────────────
// Flags guides that look like accidental re-uploads or copies: same title
// (ignoring case/punctuation) and/or same source filename. Pure function of
// the already-loaded guides list — no extra Firestore reads.

interface DuplicateGroup {
  key: string
  reason: 'title' | 'filename' | 'title+filename'
  guides: Guide[]
}

function normalizeTitle(title: string): string {
  return title.toLowerCase().trim().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim()
}

function findDuplicateGuideGroups(guides: Guide[]): DuplicateGroup[] {
  const n = guides.length
  const parent = Array.from({ length: n }, (_, i) => i)
  function find(x: number): number {
    while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x] }
    return x
  }
  function union(a: number, b: number) {
    const ra = find(a), rb = find(b)
    if (ra !== rb) parent[ra] = rb
  }

  const byTitle = new Map<string, number[]>()
  const byFilename = new Map<string, number[]>()
  guides.forEach((g, i) => {
    const tKey = normalizeTitle(g.title)
    if (tKey) byTitle.set(tKey, [...(byTitle.get(tKey) ?? []), i])
    const fKey = (g.filename || '').toLowerCase().trim()
    if (fKey) byFilename.set(fKey, [...(byFilename.get(fKey) ?? []), i])
  })
  for (const idxs of byTitle.values()) if (idxs.length > 1) for (let k = 1; k < idxs.length; k++) union(idxs[0], idxs[k])
  for (const idxs of byFilename.values()) if (idxs.length > 1) for (let k = 1; k < idxs.length; k++) union(idxs[0], idxs[k])

  const clusters = new Map<number, number[]>()
  guides.forEach((_, i) => {
    const root = find(i)
    clusters.set(root, [...(clusters.get(root) ?? []), i])
  })

  const groups: DuplicateGroup[] = []
  for (const idxs of clusters.values()) {
    if (idxs.length < 2) continue
    const groupGuides = idxs.map(i => guides[i])
    const titleKeys = new Set(groupGuides.map(g => normalizeTitle(g.title)))
    const filenameKeys = new Set(groupGuides.map(g => (g.filename || '').toLowerCase().trim()))
    const reason: DuplicateGroup['reason'] =
      titleKeys.size === 1 && filenameKeys.size === 1 ? 'title+filename'
      : titleKeys.size === 1 ? 'title'
      : 'filename'
    groups.push({ key: groupGuides.map(g => g.id).join(','), reason, guides: groupGuides })
  }
  return groups.sort((a, b) => b.guides.length - a.guides.length)
}

// ─── Main AdminHub ────────────────────────────────────────────────────────────
export default function AdminHub() {
  const [guides, setGuides] = useState<Guide[]>([])
  const [sections, setSections] = useState<Section[]>([])
  const [subscribers, setSubscribers] = useState<Subscriber[]>([])
  const [subscriberSearch, setSubscriberSearch] = useState('')
  const [siteMeta, setSiteMeta] = useState<SiteMeta>(DEFAULT_SITE_META)
  const [siteMetaDirty, setSiteMetaDirty] = useState(false)
  const [savingMeta, setSavingMeta] = useState(false)
  const [newSectionName, setNewSectionName] = useState('')
  
  // Section drag state
  const [secDraggedIdx, setSecDraggedIdx] = useState<number | null>(null)
  const [secDropIdx, setSecDropIdx] = useState<number | null>(null)
  const [secDropAbove, setSecDropAbove] = useState(true)
  const secDragRef = useRef<{ from: number | null; to: number | null; above: boolean }>({ from: null, to: null, above: true })
  
  // Link list drag state
  const [listDraggedIdx, setListDraggedIdx] = useState<number | null>(null)
  const [listDropIdx, setListDropIdx] = useState<number | null>(null)
  const [listDropAbove, setListDropAbove] = useState(true)
  const listDragRef = useRef<{ from: number | null; to: number | null; above: boolean }>({ from: null, to: null, above: true })

  // Playlist (Learning Paths) drag state
  const [playlistDraggedIdx, setPlaylistDraggedIdx] = useState<number | null>(null)
  const [playlistDropIdx, setPlaylistDropIdx] = useState<number | null>(null)
  const [playlistDropAbove, setPlaylistDropAbove] = useState(true)
  const playlistDragRef = useRef<{ from: number | null; to: number | null; above: boolean }>({ from: null, to: null, above: true })

  // Guide uploading state
  const [form, setForm] = useState<any>(null)
  const [file, setFile] = useState<File | null>(null)
  const [htmlContent, setHtmlContent] = useState('')
  const [htmlContentFr, setHtmlContentFr] = useState('')
  const [newFileFrUpload, setNewFileFrUpload] = useState<File | null>(null)
  const [uploadSectionId, setUploadSectionId] = useState('')
  const [uploadTab, setUploadTab] = useState<'en' | 'fr'>('en')
  const [translatingUpload, setTranslatingUpload] = useState(false)
  
  const [dragOver, setDragOver] = useState(false)
  const [saving, setSaving] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [fixingTitles, setFixingTitles] = useState(false)
  const [guideFilter, setGuideFilter] = useState<'all' | 'public' | 'private' | 'draft'>('all')
  const [expandedMegaGroups, setExpandedMegaGroups] = useState<Set<string>>(new Set())
  const [expandedSubSections, setExpandedSubSections] = useState<Set<string>>(new Set())

  function toggleMegaGroup(mg: string) {
    setExpandedMegaGroups(prev => {
      const next = new Set(prev)
      if (next.has(mg)) next.delete(mg); else next.add(mg)
      return next
    })
  }

  function toggleSubSection(id: string) {
    setExpandedSubSections(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  const [guideSearch, setGuideSearch] = useState('')
  const [showDuplicates, setShowDuplicates] = useState(true)
  const [confirm, setConfirm] = useState<Confirm | null>(null)
  const [linkLists, setLinkLists] = useState<LinkList[]>([])
  const [showNewList, setShowNewList] = useState(false)
  const [editingListId, setEditingListId] = useState<string | null>(null)
  const [playlists, setPlaylists] = useState<Playlist[]>([])
  const [showNewPlaylist, setShowNewPlaylist] = useState(false)
  const [editingPlaylistId, setEditingPlaylistId] = useState<string | null>(null)
  const { toast, show } = useToast()
  
  const fileInputRef = useRef<HTMLInputElement>(null)
  const fileInputFrUploadRef = useRef<HTMLInputElement>(null)

  async function loadGuides() {
    const snap = await getDocs(query(collection(db, 'guides'), orderBy('order', 'asc')))
    setGuides(snap.docs.map(d => ({ id: d.id, ...d.data() } as Guide)))
  }

  async function loadSections() {
    const snap = await getDocs(query(collection(db, 'sections'), orderBy('order', 'asc')))
    setSections(snap.docs.map(d => ({ id: d.id, ...d.data() } as Section)))
  }

  async function loadSiteMeta() {
    const snap = await getDoc(doc(db, 'meta', 'site'))
    if (snap.exists()) setSiteMeta(snap.data() as SiteMeta)
  }

  async function loadLinkLists() {
    const snap = await getDocs(query(collection(db, 'link_lists'), orderBy('order', 'asc')))
    setLinkLists(snap.docs.map(d => ({ id: d.id, ...d.data() } as LinkList)))
  }

  async function loadSubscribers() {
    const snap = await getDocs(collection(db, 'subscribers'))
    const list = snap.docs.map(d => ({ id: d.id, ...d.data() } as Subscriber))
    list.sort((a, b) => (b.signedUpAt || '').localeCompare(a.signedUpAt || ''))
    setSubscribers(list)
  }

  async function loadPlaylists() {
    const snap = await getDocs(query(collection(db, 'playlists'), orderBy('order', 'asc')))
    setPlaylists(snap.docs.map(d => ({ id: d.id, ...d.data() } as Playlist)))
  }

  useEffect(() => { loadGuides(); loadSections(); loadSiteMeta(); loadLinkLists(); loadSubscribers(); loadPlaylists() }, [])

  function exportSubscribersCsv() {
    const rows = [['Name', 'Email', 'Signed up at', 'Guide ID'], ...subscribers.map(s => [s.name, s.email, s.signedUpAt, s.guideId || ''])]
    const csv = rows.map(r => r.map(cell => `"${(cell || '').replace(/"/g, '""')}"`).join(',')).join('\n')
    const blob = new Blob([csv], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `subscribers-${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  const [translatingAll, setTranslatingAll] = useState(false)
  const [bulkProgress, setBulkProgress] = useState<{ current: number; total: number } | null>(null)
  const [translateStatus, setTranslateStatus] = useState('')
  const [openAIKey, setOpenAIKey] = useState(() => localStorage.getItem('adminOpenAIKey') || '')
  const [showKeyInput, setShowKeyInput] = useState(false)
  const [keyTestResult, setKeyTestResult] = useState<'idle' | 'testing' | 'ok' | 'fail'>('idle')

  async function testOpenAIKey() {
    if (!openAIKey) { setKeyTestResult('fail'); return }
    setKeyTestResult('testing')
    try {
      // Route through the same Cloud Function used for real translation
      // (see callOpenAITranslate) — calling api.openai.com directly from here
      // always fails on CORS regardless of key validity, so this test must
      // exercise the same path production translation actually uses.
      const translated = await callOpenAITranslate(['Say "OK" in French.'], openAIKey)
      setKeyTestResult(translated[0] ? 'ok' : 'fail')
    } catch (e) { console.error('OpenAI test error:', e); setKeyTestResult('fail') }
  }

  async function handleTranslateAll() {
    if (translatingAll) return
    if (!window.confirm('Are you sure you want to scan and auto-translate all guides? This will overwrite existing French translations with updated glossary rules.')) return
    setTranslatingAll(true)
    setBulkProgress({ current: 0, total: 0 })
    show('Scanning and auto-translating all guides...')
    try {
      const snap = await getDocs(collection(db, 'guides'))
      const total = snap.docs.length
      setBulkProgress({ current: 0, total })
      
      let count = 0
      for (let idx = 0; idx < total; idx++) {
        const d = snap.docs[idx]
        const data = d.data() as Guide
        const updates: any = {}
        const key = openAIKey || undefined
        const engine = key ? 'GPT-4o-mini' : 'Google Translate (add OpenAI key for better quality)'
        const t0 = Date.now()
        setTranslateStatus(`[${idx+1}/${total}] ${engine} → ${data.title || 'Untitled'}`)

        if (key && data.htmlContent) {
          // ── OpenAI fast path: 1-2 API calls cover ALL fields + HTML ──────
          try {
            console.log(`[translate] START ${engine} → "${data.title}" (${data.htmlContent.length} HTML chars)`)
            const result = await translateGuideFull(data, key)
            updates.title_fr = result.title_fr
            updates.description_fr = result.description_fr
            updates.tag_fr = result.tag_fr
            updates.chips_fr = result.chips_fr
            updates.htmlContent_fr = result.htmlContent_fr
          } catch (err) {
            console.warn('[translate] OpenAI failed, falling back to Google Translate', err)
            if (data.title) updates.title_fr = await translateText(data.title)
            if (data.description) updates.description_fr = await translateText(data.description)
            if (data.tag) updates.tag_fr = await translateText(data.tag)
            if (data.chips?.length) updates.chips_fr = await Promise.all(data.chips.map(c => translateText(c)))
            updates.htmlContent_fr = await translateHtmlContent(data.htmlContent)
          }
        } else {
          // ── Google Translate slow path (no key) ───────────────────────────
          if (data.title) updates.title_fr = await translateText(data.title)
          if (data.description) updates.description_fr = await translateText(data.description)
          if (data.tag) updates.tag_fr = await translateText(data.tag)
          if (data.chips?.length) updates.chips_fr = await Promise.all(data.chips.map(c => translateText(c)))
          if (data.htmlContent) updates.htmlContent_fr = await translateHtmlContent(data.htmlContent)
        }

        console.log(`[translate] DONE "${data.title}" in ${((Date.now()-t0)/1000).toFixed(1)}s`)

        if (Object.keys(updates).length > 0) {
          await updateDoc(doc(db, 'guides', d.id), updates)
          count++
        }

        setBulkProgress({ current: idx + 1, total })
      }
      show(`Bulk translation complete! Force-updated ${count} guides.`)
      loadGuides()
    } catch (err) {
      console.error(err)
      show('Bulk translation failed.', 'error')
    } finally {
      setTranslatingAll(false)
      setBulkProgress(null)
    }
  }

  // Only translate guides that are missing htmlContent_fr — much faster and
  // non-destructive vs handleTranslateAll which re-translates everything.
  async function handleTranslateMissing() {
    if (translatingAll) return
    const missing = guides.filter(g => !g.htmlContent_fr)
    if (missing.length === 0) { show('All published guides already have French translations.'); return }
    if (!window.confirm(`Translate ${missing.length} guide(s) missing French content? This may take a few minutes.`)) return
    setTranslatingAll(true)
    setBulkProgress({ current: 0, total: missing.length })
    try {
      for (let i = 0; i < missing.length; i++) {
        const g = missing[i]
        const key = openAIKey || undefined
        const engine = key ? 'GPT-4o-mini' : 'Google Translate'
        const t0 = Date.now()
        setTranslateStatus(`[${i+1}/${missing.length}] ${engine} → ${g.title}`)
        console.log(`[translate] START ${engine} → "${g.title}" (${g.htmlContent?.length || 0} HTML chars)`)

        const updates: any = {}

        if (key && g.htmlContent) {
          // ── OpenAI fast path: 1-2 API calls cover ALL fields + HTML ──────
          try {
            const result = await translateGuideFull(g, key)
            if (!g.title_fr)       updates.title_fr       = result.title_fr
            if (!g.description_fr) updates.description_fr = result.description_fr
            if (!g.tag_fr)         updates.tag_fr         = result.tag_fr
            if (!g.chips_fr?.length) updates.chips_fr     = result.chips_fr
            updates.htmlContent_fr = result.htmlContent_fr
          } catch (err) {
            console.warn('[translate] OpenAI failed, falling back to Google Translate', err)
            // fallthrough to slow path below
            if (g.title && !g.title_fr)       updates.title_fr       = await translateText(g.title)
            if (g.description && !g.description_fr) updates.description_fr = await translateText(g.description)
            if (g.tag && !g.tag_fr)           updates.tag_fr         = await translateText(g.tag)
            updates.htmlContent_fr = await translateHtmlContent(g.htmlContent)
          }
        } else {
          // ── Google Translate slow path (no key) ───────────────────────────
          if (g.title && !g.title_fr)       updates.title_fr       = await translateText(g.title)
          if (g.description && !g.description_fr) updates.description_fr = await translateText(g.description)
          if (g.tag && !g.tag_fr)           updates.tag_fr         = await translateText(g.tag)
          if (g.chips?.length && !g.chips_fr?.length)
            updates.chips_fr = await Promise.all(g.chips.map(c => translateText(c)))
          if (g.htmlContent) updates.htmlContent_fr = await translateHtmlContent(g.htmlContent)
        }

        if (Object.keys(updates).length > 0) {
          await updateDoc(doc(db, 'guides', g.id), updates)
        }
        console.log(`[translate] DONE "${g.title}" in ${((Date.now()-t0)/1000).toFixed(1)}s`)
        setBulkProgress({ current: i + 1, total: missing.length })
      }
      setTranslateStatus('')
      show(`Done! Translated ${missing.length} guide(s).`)
      loadGuides()
    } catch (err) {
      console.error(err)
      setTranslateStatus('')
      show('Translation failed — check console (F12).', 'error')
    } finally {
      setTranslatingAll(false)
      setBulkProgress(null)
    }
  }

  async function saveSiteMeta() {
    setSavingMeta(true)
    try {
      await setDoc(doc(db, 'meta', 'site'), siteMeta)
      show('Site settings saved!')
      setSiteMetaDirty(false)
    } catch (err) {
      show('Save failed.', 'error'); console.error(err)
    } finally {
      setSavingMeta(false)
    }
  }

  async function addSection() {
    if (!newSectionName.trim()) return
    const order = (sections[sections.length - 1]?.order ?? -1) + 1
    await addDoc(collection(db, 'sections'), { name: newSectionName.trim(), name_fr: '', intro: '', intro_fr: '', order })
    setNewSectionName('')
    loadSections()
  }

  async function updateSection(id: string, name: string, intro: string, nameFr: string, introFr: string) {
    await updateDoc(doc(db, 'sections', id), { 
      name: name.trim(), 
      intro: intro.trim(),
      name_fr: nameFr.trim() || null,
      intro_fr: introFr.trim() || null,
    })
    show('Section updated.')
    loadSections()
  }

  async function updateSectionMegaGroup(id: string, megaGroup: string) {
    await updateDoc(doc(db, 'sections', id), { megaGroup })
    loadSections()
  }

  async function deleteSection(id: string) {
    await deleteDoc(doc(db, 'sections', id))
    show('Section deleted.')
    loadSections()
  }

  async function reorderSections(fromIdx: number, toIdx: number) {
    if (fromIdx === toIdx) return
    const reordered = [...sections]
    const [moved] = reordered.splice(fromIdx, 1)
    reordered.splice(toIdx, 0, moved)
    setSections(reordered) // optimistic update
    try {
      await Promise.all(reordered.map((s, i) => updateDoc(doc(db, 'sections', s.id), { order: i * 10 })))
    } catch (err) {
      show('Reorder failed.', 'error')
      loadSections() // revert
    }
  }

  // ── Section drag handlers ──────────────────────────────────────────────────

  function handleSecDragOver(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault()
    const row = (e.target as HTMLElement).closest('[data-drag-idx]') as HTMLElement | null
    if (!row) return
    const idx = parseInt(row.dataset.dragIdx!)
    const rect = row.getBoundingClientRect()
    const above = e.clientY < rect.top + rect.height / 2
    secDragRef.current.to = idx
    secDragRef.current.above = above
    setSecDropIdx(idx)
    setSecDropAbove(above)
  }

  function handleSecDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault()
    const { from, to, above } = secDragRef.current
    if (from !== null && to !== null) {
      const finalTo = above
        ? (from < to ? to - 1 : to)
        : (from > to ? to + 1 : to)
      reorderSections(from, finalTo)
    }
    secDragRef.current = { from: null, to: null, above: true }
    setSecDraggedIdx(null); setSecDropIdx(null)
  }

  function handleSecDragEnd() {
    secDragRef.current = { from: null, to: null, above: true }
    setSecDraggedIdx(null); setSecDropIdx(null)
  }

  // ── Link list reorder + drag handlers ────────────────────────────────────────

  async function reorderLinkLists(fromIdx: number, toIdx: number) {
    if (fromIdx === toIdx) return
    const reordered = [...linkLists]
    const [moved] = reordered.splice(fromIdx, 1)
    reordered.splice(toIdx, 0, moved)
    setLinkLists(reordered)
    try {
      await Promise.all(reordered.map((l, i) => updateDoc(doc(db, 'link_lists', l.id), { order: i * 10 })))
    } catch (err) {
      show('Reorder failed.', 'error')
      loadLinkLists()
    }
  }

  function handleListDragOver(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault()
    const row = (e.target as HTMLElement).closest('[data-drag-idx]') as HTMLElement | null
    if (!row) return
    const idx = parseInt(row.dataset.dragIdx!)
    const rect = row.getBoundingClientRect()
    const above = e.clientY < rect.top + rect.height / 2
    listDragRef.current.to = idx
    listDragRef.current.above = above
    setListDropIdx(idx)
    setListDropAbove(above)
  }

  function handleListDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault()
    const { from, to, above } = listDragRef.current
    if (from !== null && to !== null) {
      const finalTo = above
        ? (from < to ? to - 1 : to)
        : (from > to ? to + 1 : to)
      reorderLinkLists(from, finalTo)
    }
    listDragRef.current = { from: null, to: null, above: true }
    setListDraggedIdx(null); setListDropIdx(null)
  }

  function handleListDragEnd() {
    listDragRef.current = { from: null, to: null, above: true }
    setListDraggedIdx(null); setListDropIdx(null)
  }

  async function reorderPlaylists(fromIdx: number, toIdx: number) {
    if (fromIdx === toIdx) return
    const reordered = [...playlists]
    const [moved] = reordered.splice(fromIdx, 1)
    reordered.splice(toIdx, 0, moved)
    setPlaylists(reordered)
    try {
      await Promise.all(reordered.map((p, i) => updateDoc(doc(db, 'playlists', p.id), { order: i * 10 })))
    } catch (err) {
      show('Reorder failed.', 'error')
      loadPlaylists()
    }
  }

  function handlePlaylistDragOver(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault()
    const row = (e.target as HTMLElement).closest('[data-drag-idx]') as HTMLElement | null
    if (!row) return
    const idx = parseInt(row.dataset.dragIdx!)
    const rect = row.getBoundingClientRect()
    const above = e.clientY < rect.top + rect.height / 2
    playlistDragRef.current.to = idx
    playlistDragRef.current.above = above
    setPlaylistDropIdx(idx)
    setPlaylistDropAbove(above)
  }

  function handlePlaylistDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault()
    const { from, to, above } = playlistDragRef.current
    if (from !== null && to !== null) {
      const finalTo = above
        ? (from < to ? to - 1 : to)
        : (from > to ? to + 1 : to)
      reorderPlaylists(from, finalTo)
    }
    playlistDragRef.current = { from: null, to: null, above: true }
    setPlaylistDraggedIdx(null); setPlaylistDropIdx(null)
  }

  function handlePlaylistDragEnd() {
    playlistDragRef.current = { from: null, to: null, above: true }
    setPlaylistDraggedIdx(null); setPlaylistDropIdx(null)
  }

  async function processFile(f: File) {
    if (!f.name.endsWith('.html')) { show('Only .html files are supported.', 'error'); return }
    if (f.size > MAX_SIZE_BYTES) { show('File too large (max 20 MB).', 'error'); return }
    const content = await f.text()
    setFile(f)
    setHtmlContent(content)
    
    const parsed = parseHtmlMeta(content, f.name)
    const key = openAIKey || undefined
    show(key ? 'Auto-translating guide content and metadata to French (GPT-4o-mini)...' : 'Auto-translating guide content and metadata to French (Google Translate)...')
    try {
      const translatedHtml = await translateHtmlContent(content, key)
      setHtmlContentFr(translatedHtml)

      const [title_fr, description_fr, , chips_fr] = await Promise.all([
        translateText(parsed.title, key),
        translateText(parsed.description, key),
        translateText(parsed.tag, key),
        translateText(parsed.chips, key).then(res => res.replace(/[{<〈\[(]?§[}>〉\])]?/g, ',')),
      ])

      // parsed.tag is a freeform guess from the HTML (h1/meta keywords) — not
      // a match for the controlled content-type vocabulary, so don't carry it
      // (or its translation) forward. Leave content type/level blank; the
      // admin picks from the dropdown explicitly.
      setForm({
        ...parsed,
        tag: '',
        title_fr,
        description_fr,
        tag_fr: '',
        chips_fr,
        level: '',
        level_fr: '',
      })
      setNewFileFrUpload(null)
      show('French translation generated successfully!')
    } catch (err) {
      setForm({
        ...parsed,
        tag: '',
        title_fr: '',
        description_fr: '',
        tag_fr: '',
        chips_fr: '',
        level: '',
        level_fr: '',
      })
      setHtmlContentFr('')
      setNewFileFrUpload(null)
      show('File loaded. French translation failed.', 'error')
      console.error(err)
    }
    setUploadTab('en')
  }

  async function handleDropFileFrUpload(f: File) {
    if (!f.name.endsWith('.html')) { show('Only .html files.', 'error'); return }
    if (f.size > MAX_SIZE_BYTES) { show('File too large.', 'error'); return }
    const content = await f.text()
    setHtmlContentFr(content)
    setNewFileFrUpload(f)
    show('French HTML file loaded successfully!')
  }

  async function handleAutoTranslateUpload() {
    if (!form) return
    setTranslatingUpload(true)
    const key = openAIKey || undefined
    show(key ? 'Translating metadata to French (GPT-4o-mini)...' : 'Translating metadata to French (Google Translate)...')
    try {
      const [title_fr, description_fr, tag_fr, chips_fr] = await Promise.all([
        translateText(form.title, key),
        translateText(form.description, key),
        translateText(form.tag, key),
        translateText(form.chips, key).then(res => res.replace(/[{<〈\[(]?§[}>〉\])]?/g, ',')),
      ])
      setForm((prev: any) => prev && ({
        ...prev,
        title_fr,
        description_fr,
        tag_fr,
        chips_fr,
      }))
      show('Metadata translated!')
    } catch (err) {
      show('Translation failed.', 'error')
      console.error(err)
    } finally {
      setTranslatingUpload(false)
    }
  }

  async function handleSaveNewGuide(e: React.FormEvent) {
    e.preventDefault()
    if (!file || !form) return
    setSaving(true)
    try {
      // Pre-generate the doc ID so large HTML can be uploaded to Storage at a
      // path keyed by guide ID before the Firestore doc itself is written.
      const newRef = doc(collection(db, 'guides'))
      const [en, fr] = await Promise.all([
        persistGuideHtml(newRef.id, 'en', htmlContent),
        persistGuideHtml(newRef.id, 'fr', htmlContentFr.trim()),
      ])
      await setDoc(newRef, {
        title: form.title.trim(),
        description: form.description.trim(),
        icon: form.icon.trim() || '📄',
        tag: form.tag.trim(),
        chips: form.chips.split(',').map((c: string) => c.trim()).filter(Boolean),
        level: form.level || null,
        htmlContent: en.inline,
        htmlUrl: en.url,
        filename: file.name,
        published: false,
        visibility: 'draft',
        private: false,
        order: Number(form.order) || 0,
        sectionId: uploadSectionId || null,
        created_at: serverTimestamp(),

        // French fields
        title_fr: form.title_fr.trim() || null,
        description_fr: form.description_fr.trim() || null,
        tag_fr: form.tag_fr.trim() || null,
        chips_fr: form.chips_fr.replace(/[{<〈\[(]?§[}>〉\])]?/g, ',').split(',').map((c: string) => c.trim()).filter(Boolean),
        level_fr: form.level_fr || null,
        htmlContent_fr: fr.inline,
        htmlUrl_fr: fr.url,
        filename_fr: newFileFrUpload ? newFileFrUpload.name : null,
      })
      setFile(null); setForm(null); setHtmlContent(''); setHtmlContentFr(''); setNewFileFrUpload(null); setUploadSectionId('')
      if (fileInputRef.current) fileInputRef.current.value = ''
      show('Guide saved as Draft! Update visibility when ready.')
      loadGuides()
    } catch (err) {
      show('Save failed.', 'error'); console.error(err)
    } finally {
      setSaving(false)
    }
  }

  async function quickAssignSection(guideId: string, sectionId: string) {
    await updateDoc(doc(db, 'guides', guideId), { sectionId: sectionId || null })
    show(sectionId ? 'Section assigned.' : 'Section removed.')
    loadGuides()
  }

  const [audioGeneratingId, setAudioGeneratingId] = useState<string | null>(null)
  const [translatingGuideId, setTranslatingGuideId] = useState<string | null>(null)

  // Per-guide "Translate" button on each row. Deliberately LLM-only (no
  // Google Translate fallback) — this is an explicit, one-off action the
  // admin triggers on a specific guide, so a silent lower-quality fallback
  // would be surprising; better to fail with a clear message telling them to
  // add an OpenAI key than to quietly ship a worse translation.
  async function translateOneGuide(guide: Guide) {
    if (!openAIKey) {
      show('Add an OpenAI key first (Bulk Utilities below) — this button only uses the LLM, not Google Translate.', 'error')
      return
    }
    setTranslatingGuideId(guide.id)
    try {
      const result = await translateGuideFull(guide, openAIKey)
      await updateDoc(doc(db, 'guides', guide.id), {
        title_fr: result.title_fr,
        description_fr: result.description_fr,
        tag_fr: result.tag_fr,
        chips_fr: result.chips_fr,
        htmlContent_fr: result.htmlContent_fr,
      })
      show(`Translated "${guide.title}" to French.`)
      loadGuides()
    } catch (err) {
      console.error(err)
      show('Translation failed — check console (F12).', 'error')
    } finally {
      setTranslatingGuideId(null)
    }
  }

  // Extract readable sections from guide HTML (same logic as TtsPlayer in GuideViewer)
  function extractTtsSections(html: string): Array<{ id: string; text: string }> {
    const parser = new DOMParser()
    const d = parser.parseFromString(html, 'text/html')
    d.querySelectorAll('nav.rail, .topbar, style, script, button, pre, code, .copy-btn, .chip, .tprogress').forEach(el => el.remove())
    const blocks = d.querySelectorAll('section.block, .block[id]')
    const sections: Array<{ id: string; text: string }> = []
    blocks.forEach(b => {
      const id = b.id
      const clone = b.cloneNode(true) as Element
      clone.querySelectorAll('.sec-num, button').forEach(el => el.remove())
      const text = clone.textContent?.replace(/\s+/g, ' ').trim() || ''
      if (text.length > 20) sections.push({ id, text })
    })
    return sections
  }

  async function generateAudio(guide: Guide, lang: 'en' | 'fr') {
    const html = lang === 'fr' ? (guide.htmlContent_fr || guide.htmlContent) : guide.htmlContent
    if (!html) { show('No HTML content to generate audio from.', 'error'); return }
    const sections = extractTtsSections(html)
    if (!sections.length) { show('No sections found in guide.', 'error'); return }

    setAudioGeneratingId(guide.id + '_' + lang)
    show(`Generating ${lang.toUpperCase()} audio for ${sections.length} sections… (this may take a minute)`)
    try {
      const fn = httpsCallable(getFunctions(), 'generateGuideAudio')
      const result: any = await fn({ guideId: guide.id, lang, sections })
      show(`✅ Audio generated: ${result.data.count} sections cached.`)
      loadGuides()
    } catch (err: any) {
      const msg = err?.message || String(err)
      if (msg.includes('not found') || msg.includes('FUNCTIONS') || msg.includes('unavailable')) {
        show('Cloud Functions not yet deployed — upgrade to Blaze plan first.', 'error')
      } else {
        show('Audio generation failed: ' + msg, 'error')
      }
    } finally {
      setAudioGeneratingId(null)
    }
  }

  async function togglePinned(guideId: string, pinned: boolean) {
    await updateDoc(doc(db, 'guides', guideId), { pinned })
    show(pinned ? 'Pinned to recommended.' : 'Unpinned.')
    loadGuides()
  }

  async function updateVisibility(guideId: string, val: 'public' | 'private' | 'draft') {
    const published = val === 'public'
    const isPrivate = val === 'private'
    await updateDoc(doc(db, 'guides', guideId), {
      visibility: val,
      published,
      private: isPrivate
    })
    show(`Visibility set to ${val === 'public' ? 'Published' : val === 'private' ? 'Private' : 'Draft'}.`)
    loadGuides()
  }

  function previewGuide(guide: Guide) {
    const blob = new Blob([guide.htmlContent], { type: 'text/html' })
    window.open(URL.createObjectURL(blob), '_blank')
  }

  function filenameFallbackTitle(filename: string): string {
    return filename.replace(/\.html?$/i, '').replace(/-/g, ' ').trim().toLowerCase()
  }

  function extractTitleTag(html: string): string {
    const parser = new DOMParser()
    const d = parser.parseFromString(html, 'text/html')
    return d.querySelector('title')?.textContent?.trim() || ''
  }

  // One-time backfill: some guides were saved with title === filename fallback
  // because <title> extraction didn't run or failed at upload time. Re-extract
  // the real <title> from the stored htmlContent and fix only those cases.
  async function fixTitlesFromMetadata() {
    setFixingTitles(true)
    try {
      let fixed = 0
      for (const guide of guides) {
        const updates: Record<string, string> = {}

        const realTitle = extractTitleTag(guide.htmlContent)
        if (realTitle && realTitle !== guide.title && guide.title.trim().toLowerCase() === filenameFallbackTitle(guide.filename)) {
          updates.title = realTitle
        }

        if (guide.htmlContent_fr && guide.filename_fr) {
          const realTitleFr = extractTitleTag(guide.htmlContent_fr)
          const currentTitleFr = (guide.title_fr ?? '').trim().toLowerCase()
          if (realTitleFr && realTitleFr !== guide.title_fr && currentTitleFr === filenameFallbackTitle(guide.filename_fr)) {
            updates.title_fr = realTitleFr
          }
        }

        if (Object.keys(updates).length > 0) {
          await updateDoc(doc(db, 'guides', guide.id), updates)
          fixed++
        }
      }
      show(fixed > 0 ? `Fixed ${fixed} guide title${fixed !== 1 ? 's' : ''} from metadata.` : 'All titles already match their metadata.')
      loadGuides()
    } catch (err) {
      console.error('Failed to fix titles', err)
      show('Failed to fix titles — see console.', 'error')
    } finally {
      setFixingTitles(false)
    }
  }

  function confirmDelete(guide: Guide) {
    setConfirm({
      message: `Delete "${guide.title}"? This cannot be undone.`,
      onConfirm: async () => {
        setConfirm(null)
        await deleteDoc(doc(db, 'guides', guide.id))
        show('Guide deleted.')
        loadGuides()
      }
    })
  }

  function jumpToGuide(guideId: string) {
    setGuideFilter('all')
    setExpandedId(guideId)
    requestAnimationFrame(() => {
      document.getElementById(`admin-guide-${guideId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    })
  }

  const duplicateGroups = findDuplicateGuideGroups(guides)

  // Group the "All guides" list by section, in the same order sections are
  // arranged on the public site, so scanning the admin list mirrors the hub.
  function guideMatchesListFilter(guide: Guide): boolean {
    if (guideSearch.trim() && !guide.title.toLowerCase().includes(guideSearch.trim().toLowerCase())) return false
    if (guideFilter === 'all') return true
    const isPrivate = !!(guide.visibility === 'private' || guide.private)
    const isPublished = !!(guide.visibility === 'public' || (guide.published && !isPrivate))
    const isDraft = !isPublished && !isPrivate
    if (guideFilter === 'private') return isPrivate
    if (guideFilter === 'public') return isPublished
    return isDraft
  }

  const filteredGuideList = guides.filter(guideMatchesListFilter)
  const guidesBySectionId = new Map<string, Guide[]>()
  for (const g of filteredGuideList) {
    const key = g.sectionId && sections.some(s => s.id === g.sectionId) ? g.sectionId : '__unassigned__'
    if (!guidesBySectionId.has(key)) guidesBySectionId.set(key, [])
    guidesBySectionId.get(key)!.push(g)
  }
  const groupedGuideSections: { id: string; name: string; guides: Guide[] }[] = []
  for (const s of sections) {
    const list = guidesBySectionId.get(s.id)
    if (list?.length) groupedGuideSections.push({ id: s.id, name: s.name, guides: list })
  }
  const unassignedGuides = guidesBySectionId.get('__unassigned__')
  if (unassignedGuides?.length) groupedGuideSections.push({ id: '__unassigned__', name: '⚠ No section', guides: unassignedGuides })

  // Mega-group wrapper: Product / Tools / Books, each collapsed by default,
  // containing the sections (and their guides) assigned to it. Sections with
  // no megaGroup set yet fall into an "Unassigned" bucket so nothing is lost.
  const sectionsById = new Map(sections.map(s => [s.id, s]))
  const megaGroupOf = (sectionId: string) => sectionsById.get(sectionId)?.megaGroup || 'Unassigned'
  const groupedByMegaGroup: { megaGroup: string; sections: typeof groupedGuideSections; guideCount: number }[] = []
  for (const mg of [...MEGA_GROUPS, 'Unassigned']) {
    const secs = groupedGuideSections.filter(g => g.id === '__unassigned__' ? mg === 'Unassigned' : megaGroupOf(g.id) === mg)
    if (secs.length === 0) continue
    groupedByMegaGroup.push({ megaGroup: mg, sections: secs, guideCount: secs.reduce((n, s) => n + s.guides.length, 0) })
  }

  return (
    <>
      <div className="admin-topbar">
        <span className="logo">📚 Knowledge Hub</span>
        <span className="badge">Admin</span>
        <div className="spacer" />
        <a href="/" className="btn-ghost btn">View public site</a>
        <button className="btn btn-secondary btn-sm" onClick={() => signOut(auth)}>Sign out</button>
      </div>

      <main className="admin-main">

        {/* ── Pinned & Recommended ── */}
        {guides.some(g => g.pinned) && (
          <div className="admin-section">
            <PinnedCarousel
              guides={guides.filter(g => g.pinned)}
              lang="en"
              onSelect={id => { const g = guides.find(x => x.id === id); if (g) previewGuide(g) }}
              onUnpin={id => togglePinned(id, false)}
            />
          </div>
        )}

        {/* ── Site Settings ── */}
        <div className="admin-section">
          <h3>⚙️ Site settings</h3>
          <div className="site-settings-panel">
            <div className="form-grid" style={{ marginBottom: 18 }}>
              <div className="field">
                <label>Page title (EN)</label>
                <input
                  value={siteMeta.title}
                  onChange={e => { setSiteMeta(m => ({ ...m, title: e.target.value })); setSiteMetaDirty(true) }}
                />
              </div>
              <div className="field">
                <label>Page title (FR)</label>
                <input
                  value={siteMeta.title_fr ?? ''}
                  onChange={e => { setSiteMeta(m => ({ ...m, title_fr: e.target.value })); setSiteMetaDirty(true) }}
                  placeholder="Titre en français"
                />
              </div>
              <div className="field">
                <label>Tagline (EN)</label>
                <input
                  value={siteMeta.tagline}
                  onChange={e => { setSiteMeta(m => ({ ...m, tagline: e.target.value })); setSiteMetaDirty(true) }}
                />
              </div>
              <div className="field">
                <label>Tagline (FR)</label>
                <input
                  value={siteMeta.tagline_fr ?? ''}
                  onChange={e => { setSiteMeta(m => ({ ...m, tagline_fr: e.target.value })); setSiteMetaDirty(true) }}
                  placeholder="Slogan en français"
                />
              </div>
              <div className="field field-full">
                <label>Subtitle / description (EN)</label>
                <textarea
                  value={siteMeta.subtitle}
                  onChange={e => { setSiteMeta(m => ({ ...m, subtitle: e.target.value })); setSiteMetaDirty(true) }}
                />
              </div>
              <div className="field field-full">
                <label>Subtitle / description (FR)</label>
                <textarea
                  value={siteMeta.subtitle_fr ?? ''}
                  onChange={e => { setSiteMeta(m => ({ ...m, subtitle_fr: e.target.value })); setSiteMetaDirty(true) }}
                  placeholder="Description en français"
                />
              </div>
            </div>
            {siteMetaDirty ? (
              <button className="btn btn-primary btn-sm" onClick={saveSiteMeta} disabled={savingMeta}>
                {savingMeta ? 'Saving…' : '💾 Save site settings'}
              </button>
            ) : (
              <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--muted)' }}>
                ✓ Saved — edit any field above to update
              </span>
            )}
          </div>
        </div>

        {/* ── Subscribers ── */}
        <div className="admin-section" style={{ marginTop: 24 }}>
          <h3 style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
            <span>📇 Subscribers ({subscribers.length})</span>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <input
                type="text"
                value={subscriberSearch}
                onChange={e => setSubscriberSearch(e.target.value)}
                placeholder="🔍 Search name or email…"
                style={{
                  fontFamily: 'var(--mono)', fontSize: 12, fontWeight: 600,
                  padding: '7px 14px', border: '2px solid var(--line)', borderRadius: 99,
                  background: 'var(--paper)', boxShadow: 'var(--shadow-sm)', minWidth: 200,
                }}
              />
              <button className="btn btn-secondary btn-sm" onClick={exportSubscribersCsv} disabled={subscribers.length === 0}>
                ⬇ Export CSV
              </button>
            </div>
          </h3>
          {subscribers.length === 0 ? (
            <div className="empty-state"><span className="icon">📭</span><p>No subscribers yet.</p></div>
          ) : (
            <div className="settings-panel" style={{ maxHeight: 360, overflowY: 'auto', padding: 0 }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ textAlign: 'left', borderBottom: '2px solid var(--line)', position: 'sticky', top: 0, background: 'var(--paper)' }}>
                    <th style={{ padding: '8px 14px' }}>Name</th>
                    <th style={{ padding: '8px 14px' }}>Email</th>
                    <th style={{ padding: '8px 14px' }}>Signed up</th>
                    <th style={{ padding: '8px 14px' }}>Via guide</th>
                  </tr>
                </thead>
                <tbody>
                  {subscribers
                    .filter(s => {
                      const q = subscriberSearch.trim().toLowerCase()
                      if (!q) return true
                      return s.name?.toLowerCase().includes(q) || s.email?.toLowerCase().includes(q)
                    })
                    .map(s => (
                      <tr key={s.id} style={{ borderBottom: '1px solid var(--cream-deep)' }}>
                        <td style={{ padding: '8px 14px' }}>{s.name || '—'}</td>
                        <td style={{ padding: '8px 14px', fontFamily: 'var(--mono)' }}>{s.email}</td>
                        <td style={{ padding: '8px 14px', color: 'var(--muted)' }}>
                          {s.signedUpAt ? new Date(s.signedUpAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—'}
                        </td>
                        <td style={{ padding: '8px 14px', color: 'var(--muted)' }}>
                          {s.guideId ? (guides.find(g => g.id === s.guideId)?.title || s.guideId) : '—'}
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* ── Bulk Utilities ── */}
        <div className="admin-section" style={{ marginTop: 24 }}>
          <h3>🛠️ Bulk Utilities</h3>
          <div className="settings-panel">
            {(() => {
              const missingFr = guides.filter(g => !g.htmlContent_fr)
              const hasKey = !!openAIKey
              return (
                <>
                  {/* ── Live translation status banner ── */}
                  {translateStatus && (
                    <div style={{ marginBottom: 12, padding: '10px 14px', background: '#1c1814', color: '#fff', borderRadius: 8, fontFamily: 'var(--mono)', fontSize: 12, display: 'flex', alignItems: 'center', gap: 10 }}>
                      <span style={{ animation: 'spin 1s linear infinite', display: 'inline-block' }}>⟳</span>
                      {translateStatus}
                    </div>
                  )}

                  {/* ── OpenAI API key ── */}
                  <div style={{ marginBottom: 16, padding: '12px 14px', background: hasKey ? 'rgba(79,157,107,.08)' : 'rgba(217,106,74,.05)', border: `1.5px solid ${hasKey ? 'var(--green)' : 'var(--orange)'}`, borderRadius: 10 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                      <span style={{ fontSize: 13, fontWeight: 700, flex: 1 }}>
                        {hasKey ? '✦ GPT-4o-mini (OpenAI) — active' : '⚠ OpenAI API key required for quality translation'}
                      </span>
                      {hasKey && <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--green)' }}>
                        {openAIKey.slice(0, 14)}…
                      </span>}
                      {hasKey && (
                        <button
                          className="btn btn-secondary btn-sm"
                          onClick={testOpenAIKey}
                          disabled={keyTestResult === 'testing'}
                          style={keyTestResult === 'ok' ? { color: 'var(--green)' } : keyTestResult === 'fail' ? { color: 'var(--red)' } : {}}
                        >
                          {keyTestResult === 'testing' ? '⟳ Testing…' : keyTestResult === 'ok' ? '✓ Connected' : keyTestResult === 'fail' ? '✗ Failed' : 'Test connection'}
                        </button>
                      )}
                      <button className="btn btn-secondary btn-sm" onClick={() => setShowKeyInput(v => !v)}>
                        {showKeyInput ? 'Close' : (hasKey ? '✎ Change' : '+ Add key')}
                      </button>
                      {hasKey && <button className="btn btn-secondary btn-sm" onClick={() => { localStorage.removeItem('adminOpenAIKey'); setOpenAIKey(''); setKeyTestResult('idle') }}>Remove</button>}
                    </div>
                    {showKeyInput && (
                      <div style={{ marginTop: 10, display: 'flex', gap: 8 }}>
                        <input
                          type="password"
                          placeholder="sk-…"
                          defaultValue={openAIKey}
                          id="openai-key-input"
                          style={{ flex: 1, padding: '8px 12px', border: '2px solid var(--line)', borderRadius: 8, fontFamily: 'var(--mono)', fontSize: 12 }}
                        />
                        <button className="btn btn-primary btn-sm" onClick={() => {
                          const val = (document.getElementById('openai-key-input') as HTMLInputElement).value.trim()
                          if (val) { localStorage.setItem('adminOpenAIKey', val); setOpenAIKey(val); setShowKeyInput(false); show('OpenAI key saved to browser.') }
                        }}>Save</button>
                      </div>
                    )}
                    <p style={{ fontSize: 11, color: 'var(--muted)', marginTop: 6 }}>
                      {hasKey
                        ? 'Using GPT-4o-mini — 1 API call per guide, full document context, ~$0.30 to translate all guides.'
                        : 'Add your OpenAI API key (platform.openai.com) for high-quality French translation. Key stored in browser only, never in source code.'}
                    </p>
                  </div>

                  {/* ── Translate missing ── */}
                  <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', flexWrap: 'wrap', marginBottom: 12 }}>
                    <div style={{ flex: 1, minWidth: 260 }}>
                      <p style={{ fontSize: 13, fontWeight: 700, marginBottom: 4 }}>
                        🇫🇷 Translate missing FR content
                        {missingFr.length > 0 && (
                          <span style={{ marginLeft: 8, fontFamily: 'var(--mono)', fontSize: 11, color: '#b85030', background: 'rgba(217,106,74,.1)', border: '1.5px solid rgba(217,106,74,.4)', borderRadius: 6, padding: '1px 7px' }}>
                            {missingFr.length} missing
                          </span>
                        )}
                      </p>
                      <p style={{ fontSize: 12, color: 'var(--muted)', margin: 0 }}>
                        {hasKey ? 'GPT-4o-mini — 1 call per guide, full context. ~$0.01/guide.' : 'Google Translate fallback — add OpenAI key above for better quality.'}
                      </p>
                    </div>
                    <button className="btn btn-primary btn-sm" onClick={handleTranslateMissing} disabled={translatingAll || missingFr.length === 0}>
                      {translatingAll ? '⏳ Translating…' : `${hasKey ? '✦' : '✨'} Translate ${missingFr.length} missing`}
                    </button>
                  </div>

                  {/* ── Re-translate all ── */}
                  <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', flexWrap: 'wrap' }}>
                    <div style={{ flex: 1, minWidth: 260 }}>
                      <p style={{ fontSize: 13, fontWeight: 700, marginBottom: 4 }}>🔄 Re-translate all guides</p>
                      <p style={{ fontSize: 12, color: 'var(--muted)', margin: 0 }}>Overwrites ALL existing French translations with fresh versions.</p>
                    </div>
                    <button className="btn btn-secondary btn-sm" onClick={handleTranslateAll} disabled={translatingAll}>
                      {translatingAll ? '⏳ Translating…' : `${hasKey ? '✦ GPT-4o-mini' : '↺ Google'}: Re-translate all`}
                    </button>
                  </div>
                </>
              )
            })()}
            {bulkProgress && bulkProgress.total > 0 && (
              <div style={{ marginTop: 16, maxWidth: 400 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontFamily: 'var(--mono)', fontSize: 11, marginBottom: 6 }}>
                  <span>Progress:</span>
                  <span>{bulkProgress.current} / {bulkProgress.total}</span>
                </div>
                <div style={{
                  width: '100%', height: 12, background: 'var(--cream)', border: '2px solid var(--ink)',
                  borderRadius: 0, position: 'relative', overflow: 'hidden'
                }}>
                  <div style={{
                    width: `${(bulkProgress.current / bulkProgress.total) * 100}%`,
                    height: '100%', background: 'var(--orange)',
                    transition: 'width 0.3s ease'
                  }} />
                </div>
              </div>
            )}
          </div>
        </div>

        {/* ── Sections ── */}
        <div className="admin-section">
          <h3>📐 Sections</h3>
          <div
            className="sections-panel"
            onDragOver={handleSecDragOver}
            onDrop={handleSecDrop}
            onDragEnd={handleSecDragEnd}
          >
            {sections.length === 0 && (
              <div style={{ fontFamily: 'var(--mono)', fontSize: 13, color: 'var(--muted)', padding: '4px 2px' }}>
                No sections yet — add your first one below.
              </div>
            )}
            {sections.map((s, idx) => (
              <SectionRow
                key={s.id}
                section={s}
                idx={idx}
                isDragging={secDraggedIdx === idx}
                isDropTarget={secDropIdx === idx && secDraggedIdx !== idx}
                dropAbove={secDropAbove}
                onUpdate={(name, intro, nameFr, introFr) => updateSection(s.id, name, intro, nameFr, introFr)}
                onMegaGroupChange={mg => updateSectionMegaGroup(s.id, mg)}
                onDelete={() => deleteSection(s.id)}
                onDragStart={() => { setSecDraggedIdx(idx); secDragRef.current.from = idx }}
              />
            ))}
            <div className="add-section-row">
              <input
                value={newSectionName}
                onChange={e => setNewSectionName(e.target.value)}
                placeholder="New section name (e.g. Product Discovery)"
                onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addSection() } }}
              />
              <button className="btn btn-primary btn-sm" onClick={addSection} disabled={!newSectionName.trim()}>
                + Add
              </button>
            </div>
          </div>
        </div>

        {/* ── Link Lists ── */}
        <div className="admin-section">
          <h3 style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span>📋 Link lists</span>
            {!showNewList && (
              <button className="btn btn-secondary btn-sm" onClick={() => { setShowNewList(true); setEditingListId(null) }}>
                + Add list
              </button>
            )}
          </h3>

          {/* New list editor */}
          {showNewList && (
            <LinkListEditor
              list={{ id: '', title: '', title_fr: '', sectionId: null, order: linkLists.length * 10, items: [] }}
              sections={sections}
              isNew
              show={show}
              onSave={() => { setShowNewList(false); loadLinkLists() }}
              onCancel={() => setShowNewList(false)}
            />
          )}

          {/* Existing lists */}
          {linkLists.length === 0 && !showNewList && (
            <div className="empty-state" style={{ marginTop: 8 }}>
              <span className="icon">📭</span>
              <p>No link lists yet — click "Add list" to create one.</p>
            </div>
          )}
          <div
            className="guide-list"
            style={{ marginTop: showNewList ? 16 : 0 }}
            onDragOver={handleListDragOver}
            onDrop={handleListDrop}
            onDragEnd={handleListDragEnd}
          >
            {linkLists.map((list, idx) => {
              const section = sections.find(s => s.id === list.sectionId)
              const isDragging = listDraggedIdx === idx
              const isDropTarget = listDropIdx === idx && listDraggedIdx !== idx
              return (
                <div
                  key={list.id}
                  data-drag-idx={idx}
                  draggable={true}
                  onDragStart={() => { setListDraggedIdx(idx); listDragRef.current.from = idx }}
                  style={{
                    opacity: isDragging ? 0.3 : 1,
                    borderTop: isDropTarget && listDropAbove ? '3px solid var(--orange)' : undefined,
                    borderBottom: isDropTarget && !listDropAbove ? '3px solid var(--orange)' : undefined,
                    transition: 'opacity .12s',
                  }}
                >
                  <div className="guide-row">
                    <span className="drag-handle" title="Drag to reorder" style={{ fontSize: 16 }}>⠿</span>
                    <span className="row-icon" draggable={false}>📋</span>
                    <div className="row-info" draggable={false} onMouseDown={e => e.stopPropagation()}>
                      <div className="row-title">{list.title || <em style={{ color: 'var(--muted)' }}>Untitled</em>}</div>
                      <div className="row-meta">
                        {list.items.length} link{list.items.length !== 1 ? 's' : ''}
                        {section
                          ? <> · <span style={{ color: 'var(--orange-deep)', fontWeight: 600 }}>{section.name}</span></>
                          : <> · <span style={{ color: '#b85030' }}>⚠ No section</span></>
                        }
                      </div>
                    </div>
                    <div className="row-actions">
                      <button
                        className="btn btn-secondary btn-sm"
                        style={editingListId === list.id ? { background: 'var(--orange)', color: '#fff' } : {}}
                        onMouseDown={e => e.stopPropagation()}
                        onClick={() => { setEditingListId(editingListId === list.id ? null : list.id); setShowNewList(false) }}
                      >
                        {editingListId === list.id ? 'Close' : '✎ Edit'}
                      </button>
                      <button className="btn btn-danger btn-sm" onMouseDown={e => e.stopPropagation()} onClick={async () => {
                        await deleteDoc(doc(db, 'link_lists', list.id))
                        show('List deleted.')
                        loadLinkLists()
                      }}>Delete</button>
                    </div>
                  </div>
                  {editingListId === list.id && (
                    <LinkListEditor
                      list={list}
                      sections={sections}
                      isNew={false}
                      show={show}
                      onSave={() => { setEditingListId(null); loadLinkLists() }}
                      onCancel={() => setEditingListId(null)}
                    />
                  )}
                </div>
              )
            })}
          </div>
        </div>

        {/* ── Learning Paths ── */}
        <div className="admin-section">
          <h3 style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span>🎯 Learning Paths</span>
            {!showNewPlaylist && (
              <button className="btn btn-secondary btn-sm" onClick={() => { setShowNewPlaylist(true); setEditingPlaylistId(null) }}>
                + Add path
              </button>
            )}
          </h3>

          {showNewPlaylist && (
            <PlaylistEditor
              playlist={{ id: '', title: '', title_fr: '', description: '', description_fr: '', icon: '🎯', order: playlists.length * 10, published: false, guideIds: [] }}
              guides={guides}
              isNew
              show={show}
              onSave={() => { setShowNewPlaylist(false); loadPlaylists() }}
              onCancel={() => setShowNewPlaylist(false)}
            />
          )}

          {playlists.length === 0 && !showNewPlaylist && (
            <div className="empty-state" style={{ marginTop: 8 }}>
              <span className="icon">📭</span>
              <p>No learning paths yet — click "Add path" to curate one.</p>
            </div>
          )}
          <div
            className="guide-list"
            style={{ marginTop: showNewPlaylist ? 16 : 0 }}
            onDragOver={handlePlaylistDragOver}
            onDrop={handlePlaylistDrop}
            onDragEnd={handlePlaylistDragEnd}
          >
            {playlists.map((playlist, idx) => {
              const isDragging = playlistDraggedIdx === idx
              const isDropTarget = playlistDropIdx === idx && playlistDraggedIdx !== idx
              return (
                <div
                  key={playlist.id}
                  data-drag-idx={idx}
                  draggable={true}
                  onDragStart={() => { setPlaylistDraggedIdx(idx); playlistDragRef.current.from = idx }}
                  style={{
                    opacity: isDragging ? 0.3 : 1,
                    borderTop: isDropTarget && playlistDropAbove ? '3px solid var(--orange)' : undefined,
                    borderBottom: isDropTarget && !playlistDropAbove ? '3px solid var(--orange)' : undefined,
                    transition: 'opacity .12s',
                  }}
                >
                  <div className="guide-row">
                    <span className="drag-handle" title="Drag to reorder" style={{ fontSize: 16 }}>⠿</span>
                    <span className="row-icon" draggable={false}>{playlist.icon}</span>
                    <div className="row-info" draggable={false} onMouseDown={e => e.stopPropagation()}>
                      <div className="row-title">{playlist.title || <em style={{ color: 'var(--muted)' }}>Untitled</em>}</div>
                      <div className="row-meta">
                        {playlist.guideIds.length} guide{playlist.guideIds.length !== 1 ? 's' : ''}
                        {playlist.published
                          ? <> · <span style={{ color: 'var(--orange-deep)', fontWeight: 600 }}>Published</span></>
                          : <> · <span style={{ color: '#b85030' }}>Draft</span></>
                        }
                      </div>
                    </div>
                    <div className="row-actions">
                      <button
                        className="btn btn-secondary btn-sm"
                        style={editingPlaylistId === playlist.id ? { background: 'var(--orange)', color: '#fff' } : {}}
                        onMouseDown={e => e.stopPropagation()}
                        onClick={() => { setEditingPlaylistId(editingPlaylistId === playlist.id ? null : playlist.id); setShowNewPlaylist(false) }}
                      >
                        {editingPlaylistId === playlist.id ? 'Close' : '✎ Edit'}
                      </button>
                      <button className="btn btn-danger btn-sm" onMouseDown={e => e.stopPropagation()} onClick={async () => {
                        await deleteDoc(doc(db, 'playlists', playlist.id))
                        show('Learning path deleted.')
                        loadPlaylists()
                      }}>Delete</button>
                    </div>
                  </div>
                  {editingPlaylistId === playlist.id && (
                    <PlaylistEditor
                      playlist={playlist}
                      guides={guides}
                      isNew={false}
                      show={show}
                      onSave={() => { setEditingPlaylistId(null); loadPlaylists() }}
                      onCancel={() => setEditingPlaylistId(null)}
                    />
                  )}
                </div>
              )
            })}
          </div>
        </div>

        {/* ── Upload zone ── */}
        <div className="admin-section">
          <h3>➕ Upload a new guide</h3>
          <div className="upload-panel">
            <div
              className={`dropzone${dragOver ? ' drag-over' : ''}`}
              onClick={() => fileInputRef.current?.click()}
              onDragOver={e => { e.preventDefault(); setDragOver(true) }}
              onDragLeave={() => setDragOver(false)}
              onDrop={e => { e.preventDefault(); setDragOver(false); const f = e.dataTransfer.files[0]; if (f) processFile(f) }}
            >
              <div className="dz-icon">{file ? '✅' : '📂'}</div>
              {file
                ? <p className="dz-file">{file.name} ({(file.size / 1024).toFixed(1)} KB) — metadata extracted below</p>
                : <>
                    <p>Drop your <strong>.html</strong> file here to upload</p>
                    <p style={{ fontSize: 12, marginTop: 6, color: 'var(--muted)' }}>Title, description, tag &amp; chips are extracted automatically</p>
                  </>
              }
            </div>
            <input ref={fileInputRef} type="file" accept=".html" className="dz-input"
              onChange={e => { const f = e.target.files?.[0]; if (f) processFile(f) }} />

            {form && (
              <div style={{ marginTop: 20 }}>
                <div className="editor-tabs">
                  <button type="button" className={`editor-tab-btn ${uploadTab === 'en' ? 'active' : ''}`} onClick={() => setUploadTab('en')}>English Metadata</button>
                  <button type="button" className={`editor-tab-btn ${uploadTab === 'fr' ? 'active' : ''}`} onClick={() => setUploadTab('fr')}>French Metadata (Optional)</button>
                  <button type="button" className="btn btn-secondary btn-sm" style={{ marginLeft: 'auto' }} onClick={handleAutoTranslateUpload} disabled={translatingUpload}>
                    {translatingUpload ? 'Translating…' : '✨ Auto-translate EN → FR'}
                  </button>
                </div>

                <form onSubmit={handleSaveNewGuide}>
                  {uploadTab === 'en' ? (
                    <div className="form-grid">
                      <div className="field field-full">
                        <label>Title (EN)</label>
                        <input value={form.title} onChange={e => setForm((f: any) => f && ({ ...f, title: e.target.value }))} required />
                      </div>
                      <div className="field field-full">
                        <label>Description (EN)</label>
                        <textarea value={form.description} onChange={e => setForm((f: any) => f && ({ ...f, description: e.target.value }))} />
                      </div>
                      <div className="field">
                        <label>Icon</label>
                        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                          <EmojiPicker value={form.icon} onChange={v => setForm((f: any) => f && ({ ...f, icon: v }))} />
                          <input value={form.icon} onChange={e => setForm((f: any) => f && ({ ...f, icon: e.target.value }))} style={{ flex: 1 }} placeholder="or type any emoji" />
                        </div>
                      </div>
                      <div className="field">
                        <label>Content type (EN)</label>
                        <select value={form.tag} onChange={e => setForm((f: any) => f && ({ ...f, tag: e.target.value }))}>
                          <option value="">— none —</option>
                          {CONTENT_TYPES.map(t => <option key={t.en} value={t.en}>{t.en}</option>)}
                        </select>
                      </div>
                      <div className="field">
                        <label>Level</label>
                        <select value={form.level} onChange={e => setForm((f: any) => f && ({ ...f, level: e.target.value }))}>
                          <option value="">— none —</option>
                          {LEVELS.map(l => <option key={l.en} value={l.en}>{l.en}</option>)}
                        </select>
                      </div>
                      <div className="field field-full">
                        <label>Section</label>
                        <select value={uploadSectionId} onChange={e => setUploadSectionId(e.target.value)}>
                          <option value="">— No section (hidden from public) —</option>
                          {sections.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                        </select>
                      </div>
                      <div className="field">
                        <label>Chips (EN) (comma-separated)</label>
                        <input value={form.chips} onChange={e => setForm((f: any) => f && ({ ...f, chips: e.target.value }))} />
                      </div>
                      <div className="field">
                        <label>Sort order</label>
                        <input type="number" value={form.order} onChange={e => setForm((f: any) => f && ({ ...f, order: Number(e.target.value) }))} />
                      </div>
                    </div>
                  ) : (
                    <div className="form-grid">
                      <div className="field field-full">
                        <label>Title (FR)</label>
                        <input value={form.title_fr} onChange={e => setForm((f: any) => f && ({ ...f, title_fr: e.target.value }))} placeholder="Titre en français" />
                      </div>
                      <div className="field field-full">
                        <label>Description (FR)</label>
                        <textarea value={form.description_fr} onChange={e => setForm((f: any) => f && ({ ...f, description_fr: e.target.value }))} placeholder="Description en français" />
                      </div>
                      <div className="field">
                        <label>Content type (FR)</label>
                        <select value={form.tag_fr} onChange={e => setForm((f: any) => f && ({ ...f, tag_fr: e.target.value }))}>
                          <option value="">— none —</option>
                          {CONTENT_TYPES.map(t => <option key={t.fr} value={t.fr}>{t.fr}</option>)}
                        </select>
                      </div>
                      <div className="field">
                        <label>Level (FR)</label>
                        <select value={form.level_fr} onChange={e => setForm((f: any) => f && ({ ...f, level_fr: e.target.value }))}>
                          <option value="">— none —</option>
                          {LEVELS.map(l => <option key={l.fr} value={l.fr}>{l.fr}</option>)}
                        </select>
                      </div>
                      <div className="field">
                        <label>Chips (FR) (comma-separated)</label>
                        <input value={form.chips_fr} onChange={e => setForm((f: any) => f && ({ ...f, chips_fr: e.target.value }))} placeholder="Mots-clés en français" />
                      </div>
                      
                      <div className="field field-full">
                        <label>French HTML Translation Document (.html)</label>
                        <div
                          className={`dropzone${dragOver ? ' drag-over' : ''}`}
                          style={{ padding: '20px', minHeight: 'unset', marginBottom: 0 }}
                          onClick={() => fileInputFrUploadRef.current?.click()}
                          onDragOver={e => { e.preventDefault(); setDragOver(true) }}
                          onDragLeave={() => setDragOver(false)}
                          onDrop={e => { e.preventDefault(); setDragOver(false); const f = e.dataTransfer.files[0]; if (f) handleDropFileFrUpload(f) }}
                        >
                          <span style={{ fontSize: 18, marginRight: 8 }}>{newFileFrUpload ? '✅' : '📂'}</span>
                          <span style={{ fontSize: 13, color: 'var(--muted)' }}>
                            {newFileFrUpload ? `${newFileFrUpload.name} loaded` : 'Drop FR .html version here'}
                          </span>
                        </div>
                        <input ref={fileInputFrUploadRef} type="file" accept=".html" className="dz-input"
                          onChange={e => { const f = e.target.files?.[0]; if (f) handleDropFileFrUpload(f) }} />
                      </div>
                    </div>
                  )}
                  
                  <div style={{ display: 'flex', gap: 10 }}>
                    <button type="submit" className="btn btn-primary" disabled={saving}>
                      {saving ? 'Saving…' : '💾 Save guide'}
                    </button>
                    <button type="button" className="btn btn-secondary" onClick={() => { setFile(null); setForm(null); setHtmlContent(''); setHtmlContentFr(''); setNewFileFrUpload(null); setUploadSectionId('') }}>
                      Cancel
                    </button>
                  </div>
                </form>
              </div>
            )}
          </div>
        </div>

        {/* ── Redundant content detector ── */}
        {duplicateGroups.length > 0 && (
          <div className="admin-section dupe-panel">
            <h3 style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
              <span>⚠ Possible duplicate content ({duplicateGroups.length})</span>
              <button className="btn btn-secondary btn-sm" onClick={() => setShowDuplicates(v => !v)}>
                {showDuplicates ? 'Hide' : 'Show'}
              </button>
            </h3>
            {showDuplicates && (
              <div className="dupe-groups">
                {duplicateGroups.map(group => (
                  <div key={group.key} className="dupe-group">
                    <div className="dupe-group-label">
                      {group.reason === 'title+filename' ? 'Same title & filename' : group.reason === 'title' ? 'Same title' : 'Same filename'}
                      <span style={{ marginLeft: 6, opacity: 0.65 }}>· {group.guides.length} guides</span>
                    </div>
                    <div className="dupe-group-items">
                      {group.guides.map(guide => {
                        const isPrivate = guide.visibility === 'private' || guide.private
                        const isPublished = guide.visibility === 'public' || (guide.published && !isPrivate)
                        return (
                          <div key={guide.id} className="dupe-item">
                            <span className="row-icon">{guide.icon}</span>
                            <div className="row-info">
                              <div className="row-title">{guide.title}</div>
                              <div className="row-meta">{guide.filename}</div>
                            </div>
                            <span className={`status-pill ${isPublished ? 'published' : (isPrivate ? 'private' : 'draft')}`}>
                              {isPublished ? 'Published' : (isPrivate ? 'Private' : 'Draft')}
                            </span>
                            <button className="btn btn-secondary btn-sm" onClick={() => jumpToGuide(guide.id)}>Review</button>
                            <button className="btn btn-secondary btn-sm" onClick={() => previewGuide(guide)}>Preview</button>
                            <button className="btn btn-danger btn-sm" onClick={() => confirmDelete(guide)}>Delete</button>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ── Guide list ── */}
        <div className="admin-section">
          <h3 style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
            <span>📋 All guides ({guides.length})</span>
            <input
              type="text"
              value={guideSearch}
              onChange={e => setGuideSearch(e.target.value)}
              placeholder="🔍 Search guides…"
              style={{
                fontFamily: 'var(--mono)', fontSize: 12, fontWeight: 600,
                padding: '7px 14px', border: '2px solid var(--line)', borderRadius: 99,
                background: 'var(--paper)', boxShadow: 'var(--shadow-sm)', minWidth: 180,
              }}
            />
            <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
              {(['all', 'public', 'private', 'draft'] as const).map(f => (
                <button
                  key={f}
                  className={`btn btn-sm ${guideFilter === f ? 'btn-primary' : 'btn-secondary'}`}
                  onClick={() => setGuideFilter(f)}
                >
                  {f === 'all' ? 'All' : f === 'public' ? '🟢 Published' : f === 'private' ? '🔒 Private' : '⬜ Draft'}
                  {f !== 'all' && (
                    <span style={{ marginLeft: 4, fontSize: 10, opacity: 0.7 }}>
                      ({guides.filter(g => {
                        const v = g.visibility ?? (g.published ? 'public' : 'draft')
                        if (f === 'private') return v === 'private' || g.private
                        if (f === 'public') return v === 'public' || (g.published && !g.private)
                        return v === 'draft' && !g.published && !g.private
                      }).length})
                    </span>
                  )}
                </button>
              ))}
              <button className="btn btn-secondary btn-sm" onClick={fixTitlesFromMetadata} disabled={fixingTitles || guides.length === 0}>
                {fixingTitles ? 'Fixing…' : '🔧 Fix titles'}
              </button>
            </div>
          </h3>
          {guides.length === 0
            ? <div className="empty-state"><span className="icon">📭</span><p>No guides yet — drop one above.</p></div>
            : (
              <div className="guide-list guide-list-compact">
                {groupedByMegaGroup.map(mgGroup => {
                  const isExpanded = expandedMegaGroups.has(mgGroup.megaGroup)
                  return (
                  <div key={mgGroup.megaGroup} className="admin-mega-group">
                    <button className="admin-mega-group-heading" onClick={() => toggleMegaGroup(mgGroup.megaGroup)}>
                      <span className="row-chevron">{isExpanded ? '▾' : '▸'}</span>
                      {mgGroup.megaGroup}
                      <span className="admin-guide-group-count">{mgGroup.guideCount}</span>
                    </button>
                    {isExpanded && mgGroup.sections.map(group => {
                      const isSubExpanded = expandedSubSections.has(group.id)
                      return (
                <div key={group.id} className="admin-guide-group">
                  <button 
                    className="admin-guide-group-heading"
                    onClick={() => toggleSubSection(group.id)}
                    style={{ background: 'none', border: 'none', width: '100%', textAlign: 'left', cursor: 'pointer', outline: 'none', padding: '8px 4px' }}
                  >
                    <span className="row-chevron" style={{ marginRight: 6 }}>{isSubExpanded ? '▾' : '▸'}</span>
                    {group.name}
                    <span className="admin-guide-group-count">{group.guides.length}</span>
                  </button>
                  {isSubExpanded && group.guides.map(guide => {
                  const section = sections.find(s => s.id === guide.sectionId)
                  const isPrivate = guide.visibility === 'private' || guide.private
                  const isExpanded = expandedId === guide.id

                  return (
                    <div key={guide.id} id={`admin-guide-${guide.id}`}>
                      <div
                        className="guide-row guide-row-compact"
                        onClick={() => {
                          if (isExpanded) { setExpandedId(null); setEditingId(null) }
                          else setExpandedId(guide.id)
                        }}
                      >
                        <span className="row-chevron">{isExpanded ? '▾' : '▸'}</span>
                        <span className="row-icon">{guide.icon}</span>
                        <div className="row-info">
                          <div className="row-title">{guide.title}</div>
                        </div>
                        <span className="row-section">
                          {section ? section.name : <span style={{ color: '#b85030' }}>⚠ No section</span>}
                        </span>
                        <button
                          className={`row-pin-btn ${guide.pinned ? 'pinned' : ''}`}
                          title={guide.pinned ? 'Unpin from recommended' : 'Pin to recommended'}
                          onClick={e => { e.stopPropagation(); togglePinned(guide.id, !guide.pinned) }}
                        >
                          📌
                        </button>
                        <span className={`status-pill ${guide.visibility === 'public' || (guide.published && !guide.private) ? 'published' : (isPrivate ? 'private' : 'draft')}`}>
                          {guide.visibility === 'public' || (guide.published && !guide.private) ? 'Published' : (isPrivate ? 'Private' : 'Draft')}
                        </span>
                      </div>

                      {isExpanded && (
                      <div className="guide-row guide-row-expanded" onClick={e => e.stopPropagation()}>
                        <div className="row-info">
                          <div className="row-meta">
                            {guide.filename} · order {guide.order}
                            {section && <> · <span style={{ color: 'var(--orange-deep)', fontWeight: 600 }}>{section.name}</span></>}
                          </div>
                        </div>
                        <div className="row-actions">
                          <select
                            value={guide.sectionId ?? ''}
                            onChange={e => quickAssignSection(guide.id, e.target.value)}
                            title={guide.sectionId ? 'Change section' : 'No section — hidden from public'}
                            style={{
                              fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 600,
                              padding: '3px 22px 3px 8px', border: '1.5px solid',
                              borderColor: guide.sectionId ? 'var(--line)' : 'rgba(217,106,74,.6)',
                              borderRadius: 7,
                              background: guide.sectionId
                                ? `var(--cream) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath fill='%234a423a' d='M5 6L0 0h10z'/%3E%3C/svg%3E") no-repeat right 7px center`
                                : `rgba(217,106,74,.08) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath fill='%23b85030' d='M5 6L0 0h10z'/%3E%3C/svg%3E") no-repeat right 7px center`,
                              color: guide.sectionId ? 'var(--ink-soft)' : '#b85030',
                              cursor: 'pointer', outline: 'none', appearance: 'none',
                              maxWidth: 160,
                            }}
                          >
                            <option value="">⚠ No section</option>
                            {sections.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                          </select>

                          {guide.htmlContent_fr && (
                            <span className="status-pill" style={{ background: '#e3f2fd', color: '#0d47a1', borderColor: '#90caf9', marginLeft: 4 }}>
                              🇫🇷 FR
                            </span>
                          )}

                          <select
                            value={guide.visibility ?? (guide.published ? 'public' : 'draft')}
                            onChange={e => updateVisibility(guide.id, e.target.value as 'public' | 'private' | 'draft')}
                            title="Set visibility"
                            style={{
                              fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 600,
                              padding: '3px 22px 3px 8px', border: '1.5px solid var(--line)',
                              borderRadius: 7, cursor: 'pointer', outline: 'none',
                              background: `var(--paper) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath fill='%234a423a' d='M5 6L0 0h10z'/%3E%3C/svg%3E") no-repeat right 7px center`,
                              backgroundSize: '10px 6px',
                              appearance: 'none',
                              color: 'var(--ink-soft)'
                            }}
                          >
                            <option value="draft">Draft</option>
                            <option value="public">Published</option>
                            <option value="private">Private</option>
                          </select>

                          <button
                            className="btn btn-secondary btn-sm"
                            style={editingId === guide.id ? { background: 'var(--orange)', color: '#fff' } : {}}
                            onClick={() => setEditingId(editingId === guide.id ? null : guide.id)}
                          >
                            {editingId === guide.id ? 'Close' : '✎ Edit'}
                          </button>
                          <button className="btn btn-secondary btn-sm" onClick={() => previewGuide(guide)}>Preview</button>
                          <button
                            className="btn btn-secondary btn-sm"
                            disabled={translatingGuideId === guide.id}
                            onClick={() => translateOneGuide(guide)}
                          >
                            {translatingGuideId === guide.id
                              ? '⏳ Translating…'
                              : (guide.htmlContent_fr ? '🇫🇷 Re-translate' : '🇫🇷 Translate')}
                          </button>
                          <button
                            className="btn btn-secondary btn-sm"
                            title={guide.audioGeneratedAt_en ? `EN audio: ${new Date(guide.audioGeneratedAt_en).toLocaleDateString()}` : 'Generate EN audio via Vapi'}
                            disabled={audioGeneratingId === guide.id + '_en'}
                            onClick={() => generateAudio(guide, 'en')}
                          >
                            {audioGeneratingId === guide.id + '_en' ? '⏳ EN…' : (guide.audioUrls_en ? '🔊 EN ✓' : '🎙 EN')}
                          </button>
                          {guide.htmlContent_fr && (
                            <button
                              className="btn btn-secondary btn-sm"
                              title={guide.audioGeneratedAt_fr ? `FR audio: ${new Date(guide.audioGeneratedAt_fr).toLocaleDateString()}` : 'Generate FR audio via Vapi'}
                              disabled={audioGeneratingId === guide.id + '_fr'}
                              onClick={() => generateAudio(guide, 'fr')}
                            >
                              {audioGeneratingId === guide.id + '_fr' ? '⏳ FR…' : (guide.audioUrls_fr ? '🔊 FR ✓' : '🎙 FR')}
                            </button>
                          )}
                          <button className="btn btn-danger btn-sm" onClick={() => confirmDelete(guide)}>Delete</button>
                        </div>
                      </div>
                      )}

                      {isExpanded && editingId === guide.id && (
                        <EditPanel
                          guide={guide}
                          sections={sections}
                          show={show}
                          onSave={() => { setEditingId(null); loadGuides() }}
                          onCancel={() => setEditingId(null)}
                          openAIKey={openAIKey}
                        />
                      )}
                    </div>
                  )
                  })}
                </div>
                )
                })}
              </div>
              )
                })}
              </div>
            )
          }
        </div>
      </main>

      {confirm && (
        <div className="modal-backdrop" onClick={() => setConfirm(null)}>
          <div className="modal-box" onClick={e => e.stopPropagation()}>
            <h4>Are you sure?</h4>
            <p>{confirm.message}</p>
            <div className="modal-actions">
              <button className="btn btn-secondary btn-sm" onClick={() => setConfirm(null)}>Cancel</button>
              <button className="btn btn-danger btn-sm" onClick={confirm.onConfirm}>Delete</button>
            </div>
          </div>
        </div>
      )}

      {toast && <div className={`toast ${toast.type}`}>{toast.message}</div>}
    </>
  )
}

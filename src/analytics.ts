import posthog from 'posthog-js'

posthog.init('phc_oFjfcowd3LkF4KbAcsYhrdvkN5NM9Fhw4S546uKa6PxX', {
  api_host: 'https://eu.i.posthog.com',
  person_profiles: 'identified_only',
  capture_pageview: false,  // manual for SPA
  capture_pageleave: true,
  autocapture: false,       // opt for intentional events only
})

export const ph = posthog

// ── Identity ──────────────────────────────────────────────────────────────────

export function identifyReader(email: string) {
  ph.identify(email, { email, role: 'reader' })
}

export function resetIdentity() {
  ph.reset()
}

// ── Pageviews (called on each route change) ───────────────────────────────────

export function trackPage(url: string) {
  ph.capture('$pageview', { $current_url: url })
}

// ── Guide events ──────────────────────────────────────────────────────────────

export function trackGuideViewed(guideId: string, title: string, lang: string) {
  ph.capture('guide_viewed', { guide_id: guideId, title, lang })
}

export function trackGuideLiked(guideId: string, title: string, liked: boolean) {
  ph.capture(liked ? 'guide_liked' : 'guide_unliked', { guide_id: guideId, title })
}

export function trackGuideSaved(guideId: string, title: string, saved: boolean) {
  ph.capture(saved ? 'guide_saved' : 'guide_unsaved', { guide_id: guideId, title })
}

export function trackPinnedClicked(guideId: string, title: string) {
  ph.capture('pinned_guide_clicked', { guide_id: guideId, title })
}

// ── TTS events ────────────────────────────────────────────────────────────────

export function trackTtsStarted(guideId: string, lang: string, sectionCount: number) {
  ph.capture('tts_started', { guide_id: guideId, lang, section_count: sectionCount })
}

export function trackTtsSectionPlayed(guideId: string, sectionId: string, sectionTitle: string, index: number) {
  ph.capture('tts_section_played', { guide_id: guideId, section_id: sectionId, section_title: sectionTitle, section_index: index })
}

// ── Export events ─────────────────────────────────────────────────────────────

export function trackExportRequested(guideId: string, title: string, authenticated: boolean) {
  ph.capture('pdf_export_requested', { guide_id: guideId, title, authenticated })
}

// ── Auth events ───────────────────────────────────────────────────────────────

export function trackSignupStarted(source: 'guide_export' | 'like_save' | 'header' | 'login_page') {
  ph.capture('signup_started', { source })
}

export function trackMagicLinkSent(mode: 'signup' | 'login', source: string) {
  ph.capture('magic_link_sent', { mode, source })
}

export function trackSignedIn(email: string) {
  identifyReader(email)
  ph.capture('reader_signed_in', { email })
}

export function trackSignedOut() {
  ph.capture('reader_signed_out')
  resetIdentity()
}

// ── Language & navigation ─────────────────────────────────────────────────────

export function trackLanguageSwitched(from: string, to: string, context: string) {
  ph.capture('language_switched', { from, to, context })
}

export function trackSectionNavigation(sectionId: string, sectionName: string) {
  ph.capture('section_nav_clicked', { section_id: sectionId, section_name: sectionName })
}

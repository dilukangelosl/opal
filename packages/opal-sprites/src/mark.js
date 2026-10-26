// Licence footprint: one console line and a data-opal attribute on <html>. The fingerprint string is used at runtime,
// so it survives minification and shows up in every bundle that ships Opal (searchable in HTTP Archive, grep.app…).
// A commercial licensee names its grant in the page: <meta name="opal-license" content="OPAL-COM-2026-002 Fox Reel Studio">
// (licenses are issued by the licensor; the ID is listed in alpha-video/licenses/).
export const OPAL_FP = 'opal-fp-7d1a6e0c';

export function opalBanner(license) {
  return license
    ? `Opal video sprites (${OPAL_FP}) · commercial license ${license}`
    : `Opal video sprites (${OPAL_FP}) · PolyForm Noncommercial license · commercial use: dilukangelo@gmail.com`;
}

export function opalMark() {
  if (typeof document === 'undefined' || document.documentElement.hasAttribute('data-opal')) return;
  const license = document.querySelector('meta[name="opal-license"]')?.getAttribute('content')?.trim() || '';
  document.documentElement.setAttribute('data-opal', OPAL_FP);
  if (license) document.documentElement.setAttribute('data-opal-license', license);
  console.info(opalBanner(license));
}

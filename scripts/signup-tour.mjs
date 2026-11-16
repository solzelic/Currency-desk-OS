/* Build-only adaptations of the frozen tour; every match remains asserted. */
export function patchSignupTour(patch, patchRegion) {
 patch('responsive scene canvas', '<div style="position: absolute; inset: 0; background: linear-gradient(180deg, #FCFAF5, #F2ECE0);', '<div data-tour-scene="true" style="position: absolute; inset: 0; background: linear-gradient(180deg, #FCFAF5, #F2ECE0);', 2);
 patch('tour modal', '<div data-tour="true" style=', '<div data-tour="true" role="dialog" aria-modal="true" aria-label="CurrencyDesk tour" onKeyDown="{{ onTourKey }}" data-reduced="{{ tourReduced }}" style=');
 patch('tour background inert', '<div data-product="true" style=', '<div data-product="true" inert="{{ tourInert }}" style=');
 patch('tour clip condition', '<sc-if value="{{ tourIsClip }}"', '<sc-if value="{{ tourPlayClip }}"');
 patch('tour still', '<sc-if value="{{ tourSceneDeal }}"', '<sc-if value="{{ tourStillClip }}"><img src="{{ tourPoster }}" alt="{{ tourWhere }}" style="width:100%;height:100%;object-fit:cover;object-position:top;"></sc-if><sc-if value="{{ tourSceneDeal }}"');
 patch('tour caption region', '<div key="{{ tourCapKey }}" style=', '<div data-tour-caption="true" tabindex="0" role="region" aria-label="Tour description" key="{{ tourCapKey }}" style=');
 patch('tour controls', '<button onClick="{{ onTourClose }}" style=', `<div data-tour-controls="true" style="display:flex;gap:12px;">
  <button type="button" disabled="{{ tourBackDisabled }}" onClick="{{ onTourPrevious }}" style="min-height:44px;min-width:80px;border:1px solid #7FC39E;border-radius:8px;background:#17140F;color:#F1ECE1;">Previous</button>
  <button type="button" disabled="{{ tourNextDisabled }}" onClick="{{ onTourNext }}" style="min-height:44px;min-width:80px;border:1px solid #7FC39E;border-radius:8px;background:#17140F;color:#F1ECE1;">Next</button>
 </div><button data-tour-close="true" onClick="{{ onTourClose }}" style=`);
 patch('recording badge on stills', '<sc-if value="{{ exLive }}" hint-placeholder-val="{{ false }}"><span', '<sc-if value="{{ exRecording }}" hint-placeholder-val="{{ false }}"><span');
 patch('chapter still', '<sc-if value="{{ exLive }}" hint-placeholder-val="{{ false }}"><video', '<sc-if value="{{ exStill }}"><img src="{{ exShotSrc }}" alt="Recorded synthetic desk" style="display:block;width:100%;height:auto;"></sc-if><sc-if value="{{ exLive }}" hint-placeholder-val="{{ false }}"><video');
 patchRegion('recording label', '<div style="{{ exShotWrap }}">', '<sc-if value="{{ exHasTour }}"', '</span>Live</span>', '</span>Recorded example</span>');
 patchRegion('scene home currency', '<sc-if value="{{ tourSceneDeal }}"', '<sc-if value="{{ tourIsCard }}"', 'CAD', '{{ tourHomeCurrency }}', 6);
 patchRegion('scene foreign currency', '<sc-if value="{{ tourSceneDeal }}"', '<sc-if value="{{ tourIsCard }}"', 'USD', '{{ tourForeignCurrency }}', 3);
 patch('scene ID policy', 'Over your 1,000 {{ tourHomeCurrency }} ID line.', '{{ tourIdLine }}');
 patch('recorded Home caption 1', 'Every morning starts here.', 'Your desk opens here.');
 patch('recorded Home caption 2', 'The desk has already read the day: what to file, whose ID is expiring, what’s running low.', 'The shop and owner come from your signed-in account.');
 patch('recorded Home caption 3', 'A few cards, not forty tabs. Deal with them, or skip for today.', 'Finish cash and staff setup before your first shift.');
 patch('scene report', '>Large Cash Transaction Report<', '>{{ tourReport }}<');
 patch('scene officer', 'Checked by Daniel Osei', 'Checked by {{ tourOfficer }}');
 patch('reduced motion styles', '</helmet>', `<style>
[data-tour-scene] { width:960px;height:600px;transform:scale(var(--tour-scale,1));transform-origin:top left; }
[data-tourw]:first-child>div:last-child { white-space:normal!important;max-width:70%;text-align:right; }
[data-tour] button:focus-visible,[data-tour] [tabindex]:focus-visible { outline:2px solid #7FC39E;outline-offset:3px; }
[data-tour] button { min-height:44px;min-width:44px; }
[data-tour] button:disabled { opacity:.45; }
[data-tour-caption] { max-height:120px;overflow:auto; }
[data-tour][data-reduced=true] [data-tour-caption] { font-family:inherit!important;font-size:16px!important;line-height:1.5!important;max-height:220px; }
@media(prefers-reduced-motion:reduce) {
 *,*::before,*::after { animation-duration:.001s!important;animation-delay:-100s!important;animation-iteration-count:1!important;transition-duration:0s!important;scroll-behavior:auto!important; }
}
</style>\n</helmet>`);
}

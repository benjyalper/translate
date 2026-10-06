// Rulebook checks (run: `node tests/rulebook.test.js`). Cases are real strings from the
// August 2026 TikTok LQA and from Benjy's Starling tasks — each ruling has a must-flag and a
// must-NOT-flag case, so a checker can't pass by flagging everything.
'use strict';
const RB = require('../rulebook.js');

let pass = 0, fail = 0;
function ok(name, cond) { if (cond) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ ' + name); } }
function sec(t) { console.log('\n' + t); }
const rules = (src, tgt, meta) => RB.checkSegment(src, tgt, meta).map((f) => f.rule);
const flags = (src, tgt, rule, meta) => rules(src, tgt, meta).includes(rule);

sec('Ruling 1 — gender slash form');
ok('נסה/י flagged', flags('Try again', 'נסה/י שוב', 'R1-slash-short'));
ok('ונסה/י flagged (prefix stripped)', flags('Try again', 'בדוק/בדקי ונסה/י שוב', 'R1-slash-short'));
ok('צפה/י flagged', flags('Watch here!', 'צפה/י כאן!', 'R1-slash-short'));
ok('תיהנה/י flagged', flags('Enjoy', 'תיהנה/י מ-0 דמי העברה', 'R1-slash-short'));
ok('השלם/י flagged (hif\'il)', flags('Complete missions', 'השלם/י משימות', 'R1-slash-short'));
ok('הקש/י flagged', flags('Tap', 'הקש/י כאן', 'R1-slash-short'));
ok('בדוק/י flagged (holam)', flags('Check', 'בדוק/י את הסטטוס', 'R1-slash-short'));
ok('נסה/נסי NOT flagged', !flags('Try again', 'נסה/נסי שוב', 'R1-slash-short'));
ok('לחץ/י NOT flagged', rules('Tap', 'לחץ/י והחזק/החזיקי').length === 0);
ok('שתף/י, בחר/י, שלח/י, התחבר/י, הישאר/י, השתמש/י NOT flagged',
  !['שתף/י', 'בחר/י', 'שלח/י', 'התחבר/י', 'הישאר/י', 'השתמש/י', 'הצטרף/י', 'היכנס/י'].some((w) => flags('x', w + ' עכשיו', 'R1-slash-short')));
ok('שתף/שתפי flagged as unnecessary long form', flags('Share', 'שתף/שתפי את זה', 'R1-slash-long'));
ok('המשכ/י flagged (final letter)', flags('Keep going!', 'המשכ/י כך!', 'R1-final-letter'));
ok('והפעל/י flagged (ו + hifil prefix)', flags('Run a campaign', 'בחר/י פוסט והפעל/י קמפיין', 'R1-slash-short'));
ok('והשלם/י flagged', flags('Complete', 'היכנס/י והשלם/י', 'R1-slash-short'));
ok('ובחר/י, והישאר/י NOT flagged', rules('x', 'ובחר/י והישאר/י').length === 0);

sec('Ruling 15 — RLM check ignores Starling tag tokens');
ok('tag token before ( NOT flagged', !flags('x', 'O-2-0יותר המרות באתרC-2-0 (נדרש Ads Manager)', 'R15-rlm'));
ok('Latin word before ( after a tag still flagged', flags('x', 'דרך O-1-0TikTok ShopC-1-0 (חדש)', 'R15-rlm'));

sec('Ruling 19 — slash only for single persons');
ok('יוצרים/ות flagged', flags('similar creators', 'עם יוצרים/ות דומים/ות', 'R19-plural-slash'));
ok('בני/בנות flagged', flags('teens', 'בני/בנות נוער', 'R19-plural-slash'));
ok('עוקב/ת חדש/ה NOT flagged (one person)', !flags('new follower', 'עוקב/ת חדש/ה {s_num}', 'R19-plural-slash'));
ok('הוסיף/ה NOT flagged', !flags('added', '{s_name} הוסיף/ה פוסט', 'R19-plural-slash'));

sec('Ruling 6 — prefix before a placeholder');
ok('ב-{s_privacyPolicy} flagged', flags('see our {s_privacyPolicy}', 'עיין/י ב-{s_privacyPolicy} שלנו', 'R6-prefix-hyphen'));
ok('ל-{agreementLink} flagged', flags('agree to the {agreementLink}', 'הסכמת ל-{agreementLink}', 'R6-prefix-hyphen'));
ok('ב{s_privacySettings} NOT flagged', !flags('in {s_privacySettings}', 'אפשר לשנות את זה ב{s_privacySettings}', 'R6-prefix-hyphen'));
ok('ל-{s_username} NOT flagged', !flags('Reply to {s_username}', 'השב/השיבי ל-{s_username}', 'R6-prefix-hyphen'));
ok('מ{s_authorNickname} flagged (Latin value needs hyphen)', flags('from {s_authorNickname}', 'פוסט מ{s_authorNickname}', 'R6-prefix-hyphen'));
ok('ב-<b>פרופיל</b> flagged', flags('on your <b>Profile</b>', 'ב-<b>פרופיל</b> שלך', 'R6-prefix-hyphen'));
ok('ב-TikTok NOT flagged', rules('on TikTok', 'ב-TikTok').length === 0);

sec('Rulings 2/3/4/14 + percent — numbers');
ok('20$ from $20 flagged', flags('Under $20', 'מתחת ל-20$', 'R2-currency'));
ok('$20 NOT flagged', !flags('Under $20', 'פחות מ-$20', 'R2-currency'));
ok('1,000Rp from Rp1,000 flagged', flags('Rp1,000 off', 'הנחה של 1,000Rp', 'R2-currency'));
ok('en-dash range flagged', flags('$20 – $30', '$20 – $30', 'R3-range'));
ok('{a} – {b} flagged', flags('{s_time1} – {s_time2}', 'בין השעות {s_time1} – {s_time2}', 'R3-range'));
ok('$20-$30 NOT flagged', !flags('$20 – $30', '$20-$30', 'R3-range'));
ok('clause dash NOT flagged as range', !flags('Special offer – don\'t miss it', 'הצעה מיוחדת – לא כדאי לפספס', 'R3-range'));
ok('מעל ל- flagged', flags('$100+', 'מעל ל-100$', 'R4-threshold'));
ok('{num}k flagged', flags('{num}k views', '{num}k צפיות', 'R14-km'));
ok('{num},000 NOT flagged', !flags('{num}k views', '{num},000 צפיות', 'R14-km'));
ok('%{s_num} flagged', flags('({s_num}%)', '(%{s_num})', 'R-percent'));

sec('Rulings 7/9/13/18/8');
ok('unlock → לפתוח flagged', flags('Complete missions to unlock exclusive rewards.', 'השלם/השלימי משימות כדי לפתוח פרסים בלעדיים.', 'R7-unlock'));
ok('unlock → לשחרר NOT flagged', !flags('Complete missions to unlock exclusive rewards.', 'השלם/השלימי משימות כדי לשחרר פרסים בלעדיים.', 'R7-unlock'));
ok('loading without מתבצע flagged', flags('Analyzing chat...', 'ניתוח הצ\'אט…', 'R9-loading'));
ok('loading with user slash flagged', flags('Searching images...', 'מחפש/ת תמונות...', 'R9-loading'));
ok('מתבצע חיפוש NOT flagged', !flags('Searching images...', 'מתבצע חיפוש תמונות...', 'R9-loading'));
ok('bot first person NOT flagged', !flags('Searching for info about {query}...', 'אני מחפש מידע על {query}...', 'R9-loading'));
ok('teen → מתבגר flagged', flags('Invite your teen', 'הזמן/הזמיני את המתבגר/ת שלך', 'R13-teen'));
ok('translated hashtag flagged', flags('#OutfitRecap', '#סיכוםאאוטפיטים', 'R18-hashtag'));
ok('Latin hashtag NOT flagged', !flags('#OutfitRecap', '‎#OutfitRecap', 'R18-hashtag'));
ok('button imperative flagged', flags('Upgrade', 'שדרג/י', 'R8-button', { key: 'pipo_cashier_upgrade_notice_button' }));
ok('button gerund NOT flagged', !flags('Upgrade', 'שדרוג', 'R8-button', { key: 'pipo_cashier_upgrade_notice_button' }));

sec('ICU plural branches');
ok('one/other-only Hebrew ICU flagged', flags('{num, plural, one {{s_num} point} other {{s_num} points}}', '{num, plural, one {נקודה {s_num}} other {{s_num} נקודות}}', 'R-icu-branches'));
ok('one/two/many/other NOT flagged', !flags('{num, plural, one {{s_num} point} other {{s_num} points}}', '{num, plural, one {נקודה {s_num}} two {{s_num} נקודות} many {{s_num} נקודות} other {{s_num} נקודות}}', 'R-icu-branches'));

sec('Prompt');
const sp = RB.systemPrompt({ mode: 'translate', tiktok: true });
ok('prompt no longer teaches גלה/י as short', !/SHORT form[^\n]*גלה\/י/.test(sp));
ok('prompt teaches נסה/נסי', sp.includes('נסה/נסי'));
ok('prompt has no currency-after rule', !/AFTER the number for EVERY/i.test(sp) && sp.includes('$20 stays $20'));
ok('prompt uses hyphen ranges, not en-dash', /\$20-\$30/.test(sp) && !/uses an EN-DASH/.test(sp));
ok('prompt: quotes for UI names without markup', sp.includes('מעבר ל"כולם"'));
ok('prompt reads comments', /"comments"/.test(sp));
ok('plural mode keeps plural rule', /לשון רבים/.test(RB.systemPrompt({ mode: 'translate', plural: true, tiktok: true })));
ok('non-TikTok prompt has no TikTok rulebook', !RB.systemPrompt({ mode: 'translate' }).includes('TIKTOK HEBREW RULEBOOK'));

sec('Added "!" / ellipsis (506899204098 #42)');
const src42 = "Then, all you need to do is enter your payment method, and you're good to go!";
ok('added "!" flagged', flags(src42, 'לאחר מכן, כל שנותר הוא להזין אמצעי תשלום ו…זהו! הכל מוכן!', 'R-exclaim'));
ok('added ellipsis flagged', flags(src42, 'לאחר מכן, כל שנותר הוא להזין אמצעי תשלום ו…זהו! הכל מוכן!', 'R-ellipsis'));
ok('same "!" count not flagged', !flags(src42, 'לאחר מכן, כל שנותר הוא להזין אמצעי תשלום, והכל מוכן!', 'R-exclaim'));
ok('source ellipsis kept not flagged', !flags('Searching...', 'מתבצע חיפוש...', 'R-ellipsis'));

sec('Ruling 20 — LQA pattern answers (2026-10-06)');
ok('"Book now" button with ל + gerund flagged', flags('Book now', 'להזמנה עכשיו', 'R8-now-button', { key: 'ttls_JPfirstBooking_promoLanding_bookBtn' }));
ok('"Book now" plain gerund NOT flagged', !flags('Book now', 'הזמנה עכשיו', 'R8-now-button', { key: 'ttls_JPfirstBooking_promoLanding_bookBtn' }));
ok('one guardian without slash flagged', flags('A guardian account invites you to join Family Pairing', 'חשבון של אפוטרופוס מזמין אותך להצטרף לקישור משפחה', 'R19-guardian'));
ok('אפוטרופוס/ית NOT flagged', !flags('Ask your guardian to scan this QR code', 'בקש/י מהאפוטרופוס/ית שלך לסרוק את קוד ה-QR הזה', 'R19-guardian'));
ok('guardians (group) NOT flagged', !flags('Guardians can customize teen safety settings.', 'אפוטרופוסים יכולים להתאים אישית את הגדרות הבטיחות של בני נוער.', 'R19-guardian'));
ok('Congrats → ברכות flagged', flags('Congrats! ', 'ברכות! ', 'R20-congrats'));
ok('Congrats → מזל טוב NOT flagged', !flags('Congrats! ', 'מזל טוב! ', 'R20-congrats'));
ok('nudge as דחף/ה קלות flagged', flags('{s_nickname} nudged you', '{s_nickname} דחף/ה אותך קלות', 'R20-nudge'));
ok('nudge as נגיעה קלה flagged', flags('You nudged them', 'נתת להם נגיעה קלה', 'R20-nudge'));
ok('nudge as נתן/ה לך דחיפה קלה NOT flagged', !flags('{s_nickname} nudged you', '{s_nickname} נתן/ה לך דחיפה קלה', 'R20-nudge'));
ok('locked terms carry Congrats, nudge, legal name', ['Congrats', 'nudge', 'legal name'].every((en) => RB.RULED_TERMS.some((t) => t.en === en)));
ok('prompt has the dialog-question exception and Celebrate X', /לבטל את ההזמנה\?/.test(RB.STYLE) && /חוגגים את X/.test(RB.STYLE));

sec('Ruling 15 extensions (2026-10-06) — LRM before a phone number, after brand punctuation');
const phSrc = 'Call 016 or send a WhatsApp message to 600 000 016 to receive advice.';
ok('phone number without LRM flagged', flags(phSrc, 'התקשרי ל-016 או שלחי הודעת WhatsApp למספר 600 000 016 כדי לקבל ייעוץ.', 'R15-lrm-phone'));
ok('phone number with LRM NOT flagged', !flags(phSrc, 'התקשרי ל-016 או שלחי הודעת WhatsApp למספר ‎600 000 016 כדי לקבל ייעוץ.', 'R15-lrm-phone'));
ok('10,000 is not a phone number', !flags('Join 10,000 people', 'הצטרף/י ל-10,000 אנשים', 'R15-lrm-phone'));
ok('SpontanGO! without LRM flagged', flags('SpontanGO! Discount', 'הנחת SpontanGO!', 'R15-lrm-brand'));
ok('SpontanGO!‎ NOT flagged', !flags('SpontanGO! Discount', 'הנחת SpontanGO!‎', 'R15-lrm-brand'));
ok('sentence-final "on TikTok!" NOT flagged', !flags('Watch it on TikTok!', 'צפה/צפי בזה ב-TikTok!', 'R15-lrm-brand'));

sec('Ruling 17 — split sentences (2026-10-06)');
ok('_bold part that drops its period NOT flagged', !flags('milestone.', 'אבן הדרך', 'R17-period', { key: 'milestoneTemplate_template5_card_end_bold' }));
ok('main line ending in {placeholder} that takes the period NOT flagged', !flags("Here's to the next {s_nextMilestone}", 'לחיי {s_nextMilestone} הבאה.', 'R17-period'));
ok('ordinary string with an added period still flagged', flags('Save', 'שמירה.', 'R17-period'));
ok('ordinary string missing its period still flagged', flags('Your post is live.', 'הפוסט שלך פורסם', 'R17-period'));

sec('Stored-state audit (the 2026-09-28 backup)');
const audit = RB.auditStoredState({
  lockedTerms: { terms: [{ en: 'button', he: 'לחצן' }, { en: '{s_num}%', he: '%{s_num}' }, { en: 'TikTok', he: 'TikTok' }] },
  autoFix: { rules: [{ from: 'נסו', to: 'נסה/י' }, { from: 'כפתור', to: 'לחצן' }, { from: 'שלמו', to: 'שלם/י' }, { from: 'צפו', to: 'צפה/י' }] }
});
ok('flags crane "button" lock', audit.some((a) => a.en === 'button'));
ok('flags %{s_num} lock', audit.some((a) => a.en === '{s_num}%'));
ok('keeps TikTok lock', !audit.some((a) => a.en === 'TikTok'));
ok('flags נסו→נסה/י and צפו→צפה/י', audit.some((a) => a.from === 'נסו') && audit.some((a) => a.from === 'צפו'));
ok('flags כפתור→לחצן', audit.some((a) => a.from === 'כפתור'));
ok('keeps שלמו→שלם/י', !audit.some((a) => a.from === 'שלמו'));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

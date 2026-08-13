import { timeToMinutes, minutesToTime, byTime } from './date.mjs';
let ok = true;
const t = (label, got, want) => {
  const pass = JSON.stringify(got) === JSON.stringify(want);
  if (!pass) ok = false;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${pass ? '' : `  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}`);
};

t('midnight', timeToMinutes('00:00'), 0);
t('ten thirty', timeToMinutes('10:30'), 630);
t('single digit hour', timeToMinutes('9:05'), 545);
t('dot separator', timeToMinutes('14.15'), 855);
t('last minute', timeToMinutes('23:59'), 1439);
t('empty sorts last', timeToMinutes(''), Infinity);
t('nonsense sorts last', timeToMinutes('lunch'), Infinity);
t('impossible hour sorts last', timeToMinutes('25:00'), Infinity);
t('impossible minute sorts last', timeToMinutes('10:75'), Infinity);

t('format midnight', minutesToTime(0), '00:00');
t('format pads', minutesToTime(545), '09:05');
t('format clamps past the day', minutesToTime(24 * 60 + 30), '23:59');
t('format clamps negatives', minutesToTime(-5), '00:00');

const day = [
  { time: '15:30', text: 'service overview' },
  { time: '', text: 'no time yet' },
  { time: '10:00', text: 'CL stand up' },
  { time: '9:00', text: 'early' },
  { time: '', text: 'also untimed' },
  { time: '10:00', text: 'same slot, added later' },
];
t('sorted earliest first, untimed last',
  byTime(day.slice()).map(m => m.text),
  ['early', 'CL stand up', 'same slot, added later', 'service overview', 'no time yet', 'also untimed']);

// the paper page's Monday, shuffled
const monday = [
  { time: '15:30', text: 'WE Service Overview' },
  { time: '10:30', text: 'WE Stand up' },
  { time: '11:00', text: 'Electrum Project Update' },
  { time: '10:00', text: 'CL Stand up' },
];
t('a real day sorts correctly', byTime(monday).map(m => m.time),
  ['10:00', '10:30', '11:00', '15:30']);

// every slot the picker offers must round-trip
for (const step of [15, 30, 60]) {
  for (let m = 0; m < 24 * 60; m += step) {
    if (timeToMinutes(minutesToTime(m)) !== m) { ok = false; console.log(`FAIL  round trip at ${m} (step ${step})`); }
  }
}
console.log('PASS  every picker slot round-trips');
console.log(ok ? '\nALL PASS' : '\nFAILURES');
process.exit(ok ? 0 : 1);

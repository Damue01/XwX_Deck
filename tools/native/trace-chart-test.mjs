import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { transform } from 'esbuild';

const source = await readFile(new URL('../../src/renderer/features/trace/traceChartData.ts', import.meta.url), 'utf8');
const { code } = await transform(source, { loader: 'ts', format: 'esm' });
const { traceChartData, chartBars, chartBarAt } = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));
const first = Date.parse('2026-01-01T00:00:00Z');
const record = (offset, tokens) => ({at:new Date(first+offset).toISOString(),tokens});
const series = [record(0,100),record(1000,0),record(3600000,25),record(3*86400000,64)];
const data = traceChartData([...series].reverse());
assert.deepEqual(data.anchors.map(point=>point.value),[100,25,64]);
assert.equal(data.latest.value,64);
const bars = chartBars(data,100);
assert.equal(bars.length,3);
assert.deepEqual(bars.map(bar=>bar.height),[1,.5,.8]);
for(let i=1;i<bars.length;i++)assert.equal(bars[i-1].x+bars[i-1].width,bars[i].x,'Hours or days between requests must not add gutters');
assert.equal(chartBarAt(bars[0].x+.1,bars),chartBarAt(bars[0].x+bars[0].width-.1,bars),'A bar has a flat cap');
assert.equal(chartBarAt(bars[1].x,bars),bars[1],'The next cap begins immediately with a vertical step');
assert.equal(chartBarAt(bars[0].x-1,bars),undefined,'Blank space must not claim a request');
assert.equal(chartBarAt(100,bars),bars.at(-1));

const withZero = traceChartData([...series,record(4*86400000,0)]);
assert.deepEqual(chartBars(withZero,100),bars,'Zero-token requests do not push or reshape the chart');
assert.equal(withZero.latest.value,0,'Latest-request label keeps the actual zero usage');
const sameMinute=traceChartData([record(0,20),record(5000,80)]);
assert.equal(chartBars(sameMinute,100).length,2,'Do not aggregate requests into minute samples');
const simultaneous=chartBars(traceChartData([record(0,20),record(0,80)]),100);
assert.equal(chartBarAt(simultaneous[0].x+10,simultaneous).anchor.value,20);
assert.equal(chartBarAt(simultaneous[1].x+10,simultaneous).anchor.value,80,'Equal timestamps must remain independently hoverable');

const originalNow=Date.now;
try{Date.now=()=>first+30*86400000;assert.deepEqual(chartBars(traceChartData(series),100),bars,'Idle time cannot move bars');}finally{Date.now=originalNow;}
const many=traceChartData(Array.from({length:1000},(_,i)=>record(i*60000,i+1)));
assert.equal(many.anchors.length,1000);
const visible=chartBars(many,105);
assert.equal(visible.length,5);
assert.equal(visible[0].anchor.value,996);
assert.equal(visible.at(-1).anchor.value,1000,'Width limits the visible tail, rather than deleting historical requests');
assert.equal(chartBars(data,1).length,1);
assert.deepEqual(chartBars(data,0),[]);
assert.deepEqual(chartBars(traceChartData([]),100),[]);
const invalid=traceChartData([{at:'bad',tokens:100},record(0,Infinity),record(1000,-1)]);
assert.deepEqual(invalid.anchors,[]);
assert.equal(invalid.latest.value,0);
console.log('PASS request-driven adjacent flat bars, no idle/zero movement, exact hover and unchanged request accounting');

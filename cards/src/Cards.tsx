import React from 'react';
import {AbsoluteFill, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig, Easing} from 'remotion';
import {loadFont} from '@remotion/fonts';

// Anton (SIL Open Font License 1.1, public/fonts/OFL.txt): one heavy condensed weight.
loadFont({family: 'Anton', url: staticFile('fonts/Anton-Regular.ttf'), weight: '400'});

/** Channel style preset (channels/<name>/style.json "cards"); every prop is optional. */
export type Theme = {primary?: string; panel?: string; text?: string; font?: string; good?: string; bad?: string};
let Y = '#FFD60A';
let F = 'Anton, Impact, "Arial Narrow", sans-serif';
let PANEL = 'rgba(12,12,12,.92)';
let TXT = 'white';
let GOOD = '#3ecf8e';
let BAD = '#ff5c5c';
/** Sets the colours/font for this render (one card per render, so module state is safe). */
const useTheme = (t?: Theme) => {
  Y = t?.primary || '#FFD60A';
  F = t?.font && t.font !== 'Anton' ? `"${t.font}", Anton, Impact, sans-serif` : 'Anton, Impact, "Arial Narrow", sans-serif';
  PANEL = t?.panel || 'rgba(12,12,12,.92)';
  TXT = t?.text || 'white';
  GOOD = t?.good || '#3ecf8e';
  BAD = t?.bad || '#ff5c5c';
};
const useIn = (delay = 0) => {
  const f = useCurrentFrame();
  const {fps} = useVideoConfig();
  return spring({frame: f - delay, fps, config: {damping: 14, stiffness: 160}});
};
/** Fades the card out over its last 10 frames (the card's length comes from the timeline). */
const useOut = () => {
  const f = useCurrentFrame();
  const {durationInFrames: d} = useVideoConfig();
  return interpolate(f, [d - 10, d], [1, 0], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.in(Easing.cubic)});
};
const T: React.FC<{s?: React.CSSProperties; children: React.ReactNode}> = ({s, children}) => (
  <div style={{fontFamily: F, fontWeight: 400, color: TXT, textTransform: 'uppercase', letterSpacing: 1, ...s}}>{children}</div>
);
const fit = (text: string, base: number, maxChars: number) => (text.length > maxChars ? Math.round((base * maxChars) / text.length) : base);

export const RankCard: React.FC<{rank: number; name: string; theme?: Theme}> = ({rank, name, theme}) => {
  useTheme(theme);
  const a = useIn(), b = useIn(6), o = useOut();
  return (
    <AbsoluteFill style={{justifyContent: 'center', alignItems: 'center', opacity: o}}>
      <div style={{display: 'flex', alignItems: 'center', transform: `scale(${0.6 + 0.4 * a})`}}>
        <div style={{background: Y, borderRadius: 24, padding: '0 50px', transform: `rotate(${(1 - a) * -20}deg)`, boxShadow: '0 20px 60px rgba(0,0,0,.5)'}}>
          <T s={{fontSize: 260, color: '#111', lineHeight: 1.15}}>#{rank}</T>
        </div>
        <div style={{overflow: 'hidden', marginLeft: 30, maxWidth: 1150}}>
          <T s={{fontSize: Math.max(84, fit(name, 120, 16)), lineHeight: 1.05, transform: `translateX(${(1 - b) * -110}%)`, textShadow: '0 8px 30px rgba(0,0,0,.8)'}}>{name}</T>
        </div>
      </div>
    </AbsoluteFill>
  );
};

/** "$279", "$1,299", "$279-$349", "Around $300": counts the first number up, keeps the rest. */
const splitPrice = (price: string) => {
  const m = price.match(/\d[\d,]*(\.\d+)?/);
  if (!m || m.index === undefined) return null;
  return {pre: price.slice(0, m.index), n: parseFloat(m[0].replace(/,/g, '')), dec: m[1] ? m[1].length - 1 : 0, post: price.slice(m.index + m[0].length)};
};

export const PriceCard: React.FC<{name: string; price: string; theme?: Theme}> = ({name, price, theme}) => {
  useTheme(theme);
  const f = useCurrentFrame(), a = useIn(), b = useIn(8), o = useOut();
  const p = splitPrice(price);
  const k = interpolate(f, [8, 30], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.out(Easing.cubic)});
  const shown = p ? `${p.pre}${(p.n * k).toLocaleString('en-US', {minimumFractionDigits: p.dec, maximumFractionDigits: p.dec})}${p.post}` : price;
  return (
    <AbsoluteFill style={{justifyContent: 'flex-end', alignItems: 'flex-end', padding: 90, opacity: o}}>
      <div style={{transform: `translateX(${(1 - a) * 120}%)`, background: PANEL, borderLeft: `16px solid ${Y}`, padding: '22px 50px', borderRadius: 12, maxWidth: 900}}>
        <T s={{fontSize: 36, color: Y, letterSpacing: 8}}>Price</T>
        <T s={{fontSize: fit(name, 60, 22)}}>{name}</T>
        <T s={{fontSize: fit(shown, 150, 9), lineHeight: 1.1, color: Y, transform: `scale(${0.8 + 0.2 * b})`, transformOrigin: 'left'}}>{shown}</T>
      </div>
    </AbsoluteFill>
  );
};

export const SpecCard: React.FC<{title: string; rows: string[][]; theme?: Theme}> = ({title, rows, theme}) => {
  useTheme(theme);
  const a = useIn(), o = useOut();
  const rs = [useIn(10), useIn(16), useIn(22), useIn(28), useIn(34)];
  return (
    <AbsoluteFill style={{justifyContent: 'center', paddingLeft: 100, opacity: o}}>
      <div style={{width: 820, transform: `translateX(${(1 - a) * -130}%)`, background: PANEL, borderRadius: 16, overflow: 'hidden'}}>
        <div style={{background: Y, padding: '14px 36px'}}><T s={{fontSize: fit(title, 60, 22), color: '#111'}}>{title}</T></div>
        {rows.slice(0, 5).map(([k, v], i) => (
          <div key={i} style={{display: 'flex', justifyContent: 'space-between', gap: 30, padding: '18px 36px', borderTop: '2px solid #333', opacity: rs[i], transform: `translateY(${(1 - rs[i]) * 30}px)`}}>
            <T s={{fontSize: v ? 40 : fit(k, 44, 30), color: v ? '#aaa' : 'white'}}>{k}</T>
            {v ? <T s={{fontSize: fit(v, 48, 16), textAlign: 'right'}}>{v}</T> : null}
          </div>
        ))}
      </div>
    </AbsoluteFill>
  );
};

export const LowerThird: React.FC<{title: string; sub?: string; rank?: number | null; theme?: Theme}> = ({title, sub, rank, theme}) => {
  useTheme(theme);
  const f = useCurrentFrame(), a = useIn(), b = useIn(7), o = useOut();
  const w = interpolate(f, [0, 14], [0, 100], {extrapolateRight: 'clamp', easing: Easing.out(Easing.cubic)});
  return (
    <AbsoluteFill style={{justifyContent: 'flex-end', padding: '0 0 110px 90px', opacity: o}}>
      <div style={{width: `${w * 9}px`, height: 10, background: Y, marginBottom: 10}} />
      <div style={{display: 'flex', alignItems: 'stretch', overflow: 'hidden'}}>
        {rank !== undefined && rank !== null ? (
          <div style={{background: Y, padding: '0 22px', marginRight: 18, transform: `translateY(${(1 - a) * 100}%)`, display: 'flex', alignItems: 'center'}}>
            <T s={{fontSize: 76, color: '#111', lineHeight: 1.2}}>#{rank}</T>
          </div>
        ) : null}
        <T s={{fontSize: fit(title, 88, 22), lineHeight: 1.2, transform: `translateY(${(1 - a) * 100}%)`, textShadow: '0 6px 24px rgba(0,0,0,.8)'}}>{title}</T>
      </div>
      {sub ? (
        <div style={{overflow: 'hidden'}}>
          <T s={{fontSize: 40, textTransform: 'none', letterSpacing: 0.5, transform: `translateY(${(1 - b) * 110}%)`, background: 'rgba(0,0,0,.75)', display: 'inline-block', padding: '4px 18px'}}>{sub}</T>
        </div>
      ) : null}
    </AbsoluteFill>
  );
};

/** Spec bars: label, value and a bar whose length compares the value with the other products. */
export const SpecBars: React.FC<{title: string; rows: {label: string; value: string; pct: number}[]; theme?: Theme}> = ({title, rows, theme}) => {
  useTheme(theme);
  const f = useCurrentFrame(), a = useIn(), o = useOut();
  return (
    <AbsoluteFill style={{justifyContent: 'center', alignItems: 'flex-end', paddingRight: 100, opacity: o}}>
      <div style={{width: 860, transform: `translateX(${(1 - a) * 130}%)`, background: PANEL, borderRadius: 16, padding: '26px 40px 34px'}}>
        <T s={{fontSize: fit(title, 56, 24), color: Y, marginBottom: 10}}>{title}</T>
        {rows.slice(0, 5).map((r, i) => {
          const w = interpolate(f, [10 + i * 6, 34 + i * 6], [0, Math.max(0.06, Math.min(1, r.pct))], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.out(Easing.cubic)});
          return (
            <div key={i} style={{marginTop: 18}}>
              <div style={{display: 'flex', justifyContent: 'space-between'}}>
                <T s={{fontSize: 36, opacity: 0.75}}>{r.label}</T>
                <T s={{fontSize: fit(r.value, 40, 16)}}>{r.value}</T>
              </div>
              <div style={{height: 16, background: 'rgba(255,255,255,.12)', borderRadius: 8, marginTop: 6, overflow: 'hidden'}}>
                <div style={{height: '100%', width: `${w * 100}%`, background: Y, borderRadius: 8}} />
              </div>
            </div>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};

/** Pros (green) and cons (red), lines popping in one after another. */
export const ProsCons: React.FC<{title: string; pros: string[]; cons: string[]; theme?: Theme}> = ({title, pros, cons, theme}) => {
  useTheme(theme);
  const a = useIn(), o = useOut();
  const items = [...pros.slice(0, 3).map((t) => ({t, good: true})), ...cons.slice(0, 3).map((t) => ({t, good: false}))];
  const ins = [useIn(10), useIn(16), useIn(22), useIn(28), useIn(34), useIn(40)];
  return (
    <AbsoluteFill style={{justifyContent: 'center', paddingLeft: 100, opacity: o}}>
      <div style={{width: 900, transform: `translateX(${(1 - a) * -130}%)`, background: PANEL, borderRadius: 16, overflow: 'hidden'}}>
        <div style={{background: Y, padding: '14px 36px'}}><T s={{fontSize: fit(title, 56, 24), color: '#111'}}>{title}</T></div>
        {items.map((x, i) => (
          <div key={i} style={{display: 'flex', alignItems: 'center', gap: 22, padding: '14px 36px', borderTop: '2px solid rgba(255,255,255,.08)', opacity: ins[i], transform: `translateX(${(1 - ins[i]) * -40}px)`}}>
            <div style={{width: 46, height: 46, borderRadius: 23, background: x.good ? GOOD : BAD, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0}}>
              <T s={{fontSize: 40, color: '#111', lineHeight: 1}}>{x.good ? '+' : '\u2013'}</T>
            </div>
            <T s={{fontSize: fit(x.t, 40, 30), textTransform: 'none', letterSpacing: 0.5}}>{x.t}</T>
          </div>
        ))}
      </div>
    </AbsoluteFill>
  );
};

/** Price tag swinging in from the top-right corner, price counting up. */
export const PriceTag: React.FC<{name: string; price: string; note?: string; theme?: Theme}> = ({name, price, note, theme}) => {
  useTheme(theme);
  const f = useCurrentFrame(), a = useIn(), o = useOut();
  const p = splitPrice(price);
  const k = interpolate(f, [8, 28], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.out(Easing.cubic)});
  const shown = p ? `${p.pre}${(p.n * k).toLocaleString('en-US', {minimumFractionDigits: p.dec, maximumFractionDigits: p.dec})}${p.post}` : price;
  const swing = Math.sin(f / 9) * 4 * Math.max(0, 1 - f / 60);
  return (
    <AbsoluteFill style={{alignItems: 'flex-end', padding: '70px 110px', opacity: o}}>
      <div style={{transformOrigin: '50% 0', transform: `translateY(${(1 - a) * -140}%) rotate(${-6 + swing}deg)`, display: 'flex', flexDirection: 'column', alignItems: 'center'}}>
        <div style={{width: 6, height: 50, background: '#ddd'}} />
        <div style={{background: Y, borderRadius: '18px 18px 26px 26px', padding: '20px 54px 26px', boxShadow: '0 20px 60px rgba(0,0,0,.5)', textAlign: 'center'}}>
          <div style={{width: 24, height: 24, borderRadius: 12, background: 'rgba(0,0,0,.35)', margin: '0 auto 8px'}} />
          <T s={{fontSize: fit(shown, 130, 8), color: '#111', lineHeight: 1.05}}>{shown}</T>
          <T s={{fontSize: fit(name, 38, 20), color: '#111', opacity: 0.8}}>{name}</T>
          {note ? <T s={{fontSize: 28, color: '#111', opacity: 0.7, textTransform: 'none'}}>{note}</T> : null}
        </div>
      </div>
    </AbsoluteFill>
  );
};

/** Comparison table: products as columns, specs as rows; the current product's column is highlighted. */
export const CompareTable: React.FC<{title: string; products: string[]; rows: {label: string; values: string[]}[]; highlight?: number; theme?: Theme}> = ({title, products, rows, highlight, theme}) => {
  useTheme(theme);
  const a = useIn(), o = useOut();
  const ins = [useIn(8), useIn(13), useIn(18), useIn(23), useIn(28), useIn(33)];
  const cols = products.slice(0, 5);
  const colW = Math.min(360, Math.floor(1300 / Math.max(1, cols.length)));
  return (
    <AbsoluteFill style={{justifyContent: 'center', alignItems: 'center', opacity: o}}>
      <div style={{transform: `scale(${0.85 + 0.15 * a})`, opacity: a, background: PANEL, borderRadius: 18, padding: '24px 30px 30px', boxShadow: '0 30px 80px rgba(0,0,0,.6)'}}>
        <T s={{fontSize: fit(title, 54, 34), color: Y, textAlign: 'center', marginBottom: 14}}>{title}</T>
        <div style={{display: 'flex'}}>
          <div style={{width: 260}} />
          {cols.map((p, i) => (
            <div key={i} style={{width: colW, padding: '10px 12px', textAlign: 'center', background: i === highlight ? Y : 'transparent', borderRadius: '10px 10px 0 0'}}>
              <T s={{fontSize: fit(p, 34, Math.max(8, Math.round(colW / 22))), color: i === highlight ? '#111' : TXT}}>{p}</T>
            </div>
          ))}
        </div>
        {rows.slice(0, 6).map((r, ri) => (
          <div key={ri} style={{display: 'flex', borderTop: '2px solid rgba(255,255,255,.1)', opacity: ins[ri], transform: `translateY(${(1 - ins[ri]) * 20}px)`}}>
            <div style={{width: 260, padding: '14px 12px'}}><T s={{fontSize: 32, opacity: 0.7}}>{r.label}</T></div>
            {cols.map((_, i) => (
              <div key={i} style={{width: colW, padding: '14px 12px', textAlign: 'center', background: i === highlight ? 'rgba(255,255,255,.08)' : 'transparent'}}>
                <T s={{fontSize: fit(r.values[i] ?? '-', 36, 12)}}>{r.values[i] || '-'}</T>
              </div>
            ))}
          </div>
        ))}
      </div>
    </AbsoluteFill>
  );
};

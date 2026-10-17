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

/**
 * Clean price panel (dark glass + accent bar). Big bold number, subtle currency, product name.
 * Spring slide/scale entrance, the number counts up, smooth slide-out exit. Any price format:
 * "$279", "€1.299", "Rs 45,000", "$279-$349", "Around $300", "Free", "Check price".
 */
const PricePanel: React.FC<{name: string; price: string; note?: string; corner: 'br' | 'tr'; label?: string}> = ({name, price, note, corner, label}) => {
  const f = useCurrentFrame();
  const {fps, durationInFrames: d} = useVideoConfig();
  const a = spring({frame: f, fps, config: {damping: 18, stiffness: 140, mass: 0.9}});
  const b = spring({frame: f - 6, fps, config: {damping: 16, stiffness: 120}});
  const bar = spring({frame: f - 3, fps, config: {damping: 20, stiffness: 110}});
  const out = spring({frame: f - (d - 14), fps, config: {damping: 20, stiffness: 160}});
  const p = splitPrice(price);
  const k = interpolate(f, [6, 30], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.out(Easing.cubic)});
  const num = p ? (p.n * k).toLocaleString('en-US', {minimumFractionDigits: p.dec, maximumFractionDigits: p.dec}) : '';
  // Prefix: leading words ("Around", "From") become a small label, a currency symbol/code stays subtle.
  const preRaw = p ? p.pre.trim() : '';
  const cur = (preRaw.match(/([$€£¥₹]|Rs\.?|PKR|USD|EUR|GBP|AED|CAD|AUD)\s*$/i) || [''])[0];
  const lead = preRaw.slice(0, preRaw.length - cur.length).trim();
  const post = p ? p.post.trim() : '';
  const big = p ? num : price;
  const bigSize = Math.min(190, fit(big + (post && post.length < 4 ? post : ''), 190, 7));
  const x = (1 - a) * (corner === 'br' ? 60 : 60) + out * 70;
  const right = corner === 'br' ? 96 : 96;
  return (
    <AbsoluteFill style={{justifyContent: corner === 'br' ? 'flex-end' : 'flex-start', alignItems: 'flex-end', padding: corner === 'br' ? `0 ${right}px 110px 0` : `90px ${right}px 0 0`}}>
      <div
        style={{
          opacity: Math.min(a * 1.4, 1) * (1 - out),
          transform: `translateX(${x}px) scale(${0.92 + 0.08 * a})`,
          transformOrigin: 'right center',
          position: 'relative',
          minWidth: 520,
          maxWidth: 860,
          padding: '30px 46px 34px 56px',
          borderRadius: 22,
          background: 'linear-gradient(135deg, rgba(22,24,28,.86), rgba(8,9,11,.78))',
          border: '1.5px solid rgba(255,255,255,.12)',
          boxShadow: '0 30px 80px rgba(0,0,0,.55), inset 0 1px 0 rgba(255,255,255,.08)',
          overflow: 'hidden',
        }}
      >
        <div style={{position: 'absolute', left: 0, top: 0, bottom: 0, width: 12, background: Y, transform: `scaleY(${bar})`, transformOrigin: 'top'}} />
        <div style={{position: 'absolute', right: -120, top: -120, width: 320, height: 320, borderRadius: 160, background: Y, opacity: 0.08, filter: 'blur(10px)'}} />
        <div style={{display: 'flex', alignItems: 'center', gap: 14, opacity: b}}>
          <T s={{fontSize: 30, color: Y, letterSpacing: 7}}>{label || 'Price'}</T>
          {lead ? <T s={{fontSize: 30, color: 'rgba(255,255,255,.6)', letterSpacing: 4}}>{lead}</T> : null}
        </div>
        <div style={{display: 'flex', alignItems: 'flex-start', marginTop: 2, transform: `translateY(${(1 - b) * 24}px)`, opacity: b}}>
          {cur ? <T s={{fontSize: Math.round(bigSize * 0.42), color: 'rgba(255,255,255,.55)', lineHeight: 1, marginTop: Math.round(bigSize * 0.14), marginRight: 8}}>{cur}</T> : null}
          <T s={{fontSize: bigSize, lineHeight: 1.02, letterSpacing: 2, textShadow: '0 6px 24px rgba(0,0,0,.5)'}}>{big}</T>
          {post ? <T s={{fontSize: Math.round(bigSize * (post.length < 4 ? 0.42 : 0.3)), color: 'rgba(255,255,255,.7)', lineHeight: 1, marginTop: Math.round(bigSize * 0.14), marginLeft: 10, maxWidth: 360}}>{post}</T> : null}
        </div>
        <div style={{height: 2, background: 'rgba(255,255,255,.14)', margin: '10px 0 14px', transform: `scaleX(${bar})`, transformOrigin: 'left'}} />
        <T s={{fontSize: fit(name, 46, 24), color: 'rgba(255,255,255,.92)', letterSpacing: 2, opacity: b}}>{name}</T>
        {note ? <T s={{fontSize: 26, color: 'rgba(255,255,255,.6)', textTransform: 'none', marginTop: 6, opacity: b}}>{note}</T> : null}
      </div>
    </AbsoluteFill>
  );
};

export const PriceCard: React.FC<{name: string; price: string; theme?: Theme}> = ({name, price, theme}) => {
  useTheme(theme);
  return <PricePanel name={name} price={price} corner="br" />;
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

/** Price tag (top-right): same clean glass price panel as PriceCard, with an optional note. */
export const PriceTag: React.FC<{name: string; price: string; note?: string; theme?: Theme}> = ({name, price, note, theme}) => {
  useTheme(theme);
  return <PricePanel name={name} price={price} note={note} corner="tr" />;
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

/**
 * Gauge card: a speedometer-style arc, the needle sweeps from 0 to the value (spring), the value
 * counts up in the centre. Optional comparison bars below (other products' value for the same spec).
 * Any numeric spec: cc, hp, mph, mAh, GB, hours, ... pct = value / max (0-1).
 */
export const GaugeCard: React.FC<{title: string; label: string; value: string; pct: number; compare?: {name: string; value: string; pct: number; me?: boolean}[]; theme?: Theme}> = ({title, label, value, pct, compare, theme}) => {
  useTheme(theme);
  const f = useCurrentFrame();
  const {fps, durationInFrames: d} = useVideoConfig();
  const a = spring({frame: f, fps, config: {damping: 18, stiffness: 120}});
  const sweep = spring({frame: f - 8, fps, config: {damping: 11, stiffness: 55, mass: 1.1}});
  const out = interpolate(f, [d - 12, d], [1, 0], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});
  const p = Math.max(0.03, Math.min(1, pct)) * sweep;
  const R = 190, cx = 230, cy = 230, A0 = -210, A1 = 30; // degrees, 240° arc
  const ang = A0 + (A1 - A0) * p;
  const pt = (deg: number, r: number) => [cx + r * Math.cos((deg * Math.PI) / 180), cy + r * Math.sin((deg * Math.PI) / 180)];
  const arc = (from: number, to: number, r: number) => {
    const [x0, y0] = pt(from, r), [x1, y1] = pt(to, r);
    return `M ${x0} ${y0} A ${r} ${r} 0 ${to - from > 180 ? 1 : 0} 1 ${x1} ${y1}`;
  };
  const sp = splitPrice(value);
  const shown = sp ? `${sp.pre}${(sp.n * Math.min(1, sweep * 1.02)).toLocaleString('en-US', {minimumFractionDigits: sp.dec, maximumFractionDigits: sp.dec})}${sp.post}` : value;
  const ticks = Array.from({length: 13}, (_, i) => A0 + ((A1 - A0) * i) / 12);
  const [nx, ny] = pt(ang, R - 34);
  return (
    <AbsoluteFill style={{justifyContent: 'center', alignItems: 'flex-end', paddingRight: 110, opacity: out}}>
      <div style={{transform: `translateX(${(1 - a) * 140}px) scale(${0.9 + 0.1 * a})`, opacity: Math.min(1, a * 1.5), background: 'linear-gradient(135deg, rgba(22,24,28,.88), rgba(8,9,11,.8))', border: '1.5px solid rgba(255,255,255,.12)', borderRadius: 26, padding: '26px 34px 30px', boxShadow: '0 30px 80px rgba(0,0,0,.55)', width: 560}}>
        <T s={{fontSize: 30, color: Y, letterSpacing: 6}}>{label}</T>
        <T s={{fontSize: fit(title, 40, 24), color: 'rgba(255,255,255,.85)'}}>{title}</T>
        <svg width={460} height={330} viewBox="0 0 460 330" style={{display: 'block', margin: '6px auto 0'}}>
          <path d={arc(A0, A1, R)} stroke="rgba(255,255,255,.12)" strokeWidth={26} fill="none" strokeLinecap="round" />
          <path d={arc(A0, ang, R)} stroke={Y} strokeWidth={26} fill="none" strokeLinecap="round" style={{filter: `drop-shadow(0 0 12px ${Y})`}} />
          {ticks.map((t, i) => {
            const [x0, y0] = pt(t, R - 30), [x1, y1] = pt(t, R - (i % 3 === 0 ? 52 : 42));
            return <line key={i} x1={x0} y1={y0} x2={x1} y2={y1} stroke="rgba(255,255,255,.45)" strokeWidth={i % 3 === 0 ? 4 : 2} />;
          })}
          <line x1={cx} y1={cy} x2={nx} y2={ny} stroke="white" strokeWidth={8} strokeLinecap="round" />
          <circle cx={cx} cy={cy} r={18} fill={Y} />
        </svg>
        <T s={{fontSize: fit(shown, 84, 8), textAlign: 'center', marginTop: -10, lineHeight: 1, textShadow: '0 6px 24px rgba(0,0,0,.6)'}}>{shown}</T>
        {compare && compare.length > 1 ? (
          <div style={{marginTop: 26}}>
            {compare.slice(0, 4).map((c, i) => {
              const g = spring({frame: f - 22 - i * 6, fps, config: {damping: 18, stiffness: 110}});
              return (
                <div key={i} style={{display: 'flex', alignItems: 'center', gap: 12, marginTop: 8, opacity: g}}>
                  <T s={{fontSize: 22, width: 190, color: c.me ? Y : 'rgba(255,255,255,.75)', whiteSpace: 'nowrap', overflow: 'hidden'}}>{c.name}</T>
                  <div style={{flex: 1, height: 14, background: 'rgba(255,255,255,.1)', borderRadius: 7}}>
                    <div style={{width: `${Math.max(4, Math.min(100, c.pct * 100 * g))}%`, height: '100%', borderRadius: 7, background: c.me ? Y : 'rgba(255,255,255,.55)'}} />
                  </div>
                  <T s={{fontSize: 22, width: 110, textAlign: 'right', color: c.me ? Y : 'rgba(255,255,255,.75)'}}>{c.value}</T>
                </div>
              );
            })}
          </div>
        ) : null}
      </div>
    </AbsoluteFill>
  );
};

/**
 * Part callout on a verified product photo: 2.5D parallax (blurred backdrop drifts, photo floats),
 * a light sweep across the photo, then the camera zooms toward the part, a glowing ring pulses on it,
 * a leader line draws out and the label + value slide in. box = part bounding box (0-1, photo coords).
 */
export const PartCallout: React.FC<{photo: string; box: {x: number; y: number; w: number; h: number}; aspect: number; title: string; label: string; value: string; theme?: Theme}> = ({photo, box, aspect, title, label, value, theme}) => {
  useTheme(theme);
  const f = useCurrentFrame();
  const {fps, durationInFrames: d} = useVideoConfig();
  const inn = spring({frame: f, fps, config: {damping: 20, stiffness: 120}});
  const zoom = spring({frame: f - 18, fps, config: {damping: 22, stiffness: 50, mass: 1.2}});
  const ring = spring({frame: f - 34, fps, config: {damping: 12, stiffness: 120}});
  const line = interpolate(f, [44, 62], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.out(Easing.cubic)});
  const lab = spring({frame: f - 56, fps, config: {damping: 18, stiffness: 130}});
  const out = interpolate(f, [d - 12, d], [1, 0], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});
  // Photo fitted into a 1400x880 stage (keeps its aspect), centred.
  const SW = 1400, SH = 880;
  const pw = aspect >= SW / SH ? SW : SH * aspect, ph = aspect >= SW / SH ? SW / aspect : SH;
  const px = (1920 - pw) / 2, py = (1080 - ph) / 2;
  const bx = px + (box.x + box.w / 2) * pw, by = py + (box.y + box.h / 2) * ph;
  const z = 1 + 0.55 * zoom;
  // Zoom toward the part: translate so the part moves toward 40% width / centre height.
  const tx = (960 * 0.8 - bx) * zoom * 0.6, ty = (540 - by) * zoom * 0.6;
  const drift = Math.sin(f / 40) * 10;
  const sweepX = interpolate(f, [6, 46], [-0.4, 1.4], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});
  const rr = Math.max(46, Math.max(box.w * pw, box.h * ph) * 0.6);
  // Leader line end + label (on screen coords after the transform).
  const sx = 960 + (bx - 960) * z + tx * z / z, sy = 540 + (by - 540) * z + ty;
  const lx = Math.min(1500, sx + 260), ly = Math.max(140, sy - 170);
  return (
    <AbsoluteFill style={{opacity: out * Math.min(1, inn * 1.4), backgroundColor: '#0b0c0e'}}>
      <AbsoluteFill style={{transform: `scale(${1.25 + 0.05 * zoom}) translateX(${drift * -2}px)`, filter: 'blur(38px) brightness(.45) saturate(1.1)'}}>
        <img src={staticFile(photo)} style={{width: '100%', height: '100%', objectFit: 'cover'}} />
      </AbsoluteFill>
      <AbsoluteFill style={{transform: `translate(${tx}px, ${ty + drift}px) scale(${z})`, transformOrigin: `${bx}px ${by}px`}}>
        <div style={{position: 'absolute', left: px, top: py, width: pw, height: ph, borderRadius: 18, overflow: 'hidden', boxShadow: '0 40px 90px rgba(0,0,0,.6)', transform: `perspective(1600px) rotateY(${(1 - inn) * -12 + drift * 0.15}deg)`}}>
          <img src={staticFile(photo)} style={{width: '100%', height: '100%', objectFit: 'cover'}} />
          <div style={{position: 'absolute', top: 0, bottom: 0, left: `${sweepX * 100}%`, width: '22%', background: 'linear-gradient(100deg, rgba(255,255,255,0) 0%, rgba(255,255,255,.28) 50%, rgba(255,255,255,0) 100%)', transform: 'skewX(-18deg)'}} />
        </div>
      </AbsoluteFill>
      <svg width={1920} height={1080} style={{position: 'absolute', left: 0, top: 0}}>
        <circle cx={sx} cy={sy} r={rr * (0.6 + 0.4 * ring)} fill="none" stroke={Y} strokeWidth={6} opacity={ring} style={{filter: `drop-shadow(0 0 14px ${Y}) drop-shadow(0 0 30px ${Y})`}} />
        <circle cx={sx} cy={sy} r={rr * (1 + 0.25 * ((f % 30) / 30))} fill="none" stroke={Y} strokeWidth={2} opacity={ring * (1 - (f % 30) / 30) * 0.8} />
        <polyline points={`${sx + rr * 0.7},${sy - rr * 0.7} ${sx + rr * 0.7 + (lx - sx - rr * 0.7) * Math.min(1, line * 1.6)},${sy - rr * 0.7 + (ly - sy + rr * 0.7) * Math.min(1, line * 1.6)} ${line > 0.62 ? lx + 220 * ((line - 0.62) / 0.38) : lx},${ly}`} fill="none" stroke={Y} strokeWidth={4} opacity={line > 0 ? 1 : 0} />
      </svg>
      <div style={{position: 'absolute', left: lx + 10, top: ly - 96, opacity: lab, transform: `translateY(${(1 - lab) * 20}px)`, background: 'rgba(10,11,13,.82)', borderLeft: `8px solid ${Y}`, borderRadius: 12, padding: '12px 26px 16px', maxWidth: 520}}>
        <T s={{fontSize: 26, color: Y, letterSpacing: 5}}>{label}</T>
        <T s={{fontSize: fit(value, 56, 18), lineHeight: 1.05}}>{value}</T>
      </div>
      <div style={{position: 'absolute', left: 80, bottom: 70, opacity: inn}}>
        <T s={{fontSize: fit(title, 44, 26), color: 'rgba(255,255,255,.9)', textShadow: '0 4px 18px rgba(0,0,0,.7)'}}>{title}</T>
      </div>
    </AbsoluteFill>
  );
};

/** 2.5D product photo: parallax float over its own blurred copy plus a light sweep (used for product stills). */
export const PhotoParallax: React.FC<{photo: string; aspect: number}> = ({photo, aspect}) => {
  const f = useCurrentFrame();
  const {durationInFrames: d} = useVideoConfig();
  const t = f / Math.max(1, d - 1);
  const SW = 1500, SH = 900;
  const pw = aspect >= SW / SH ? SW : SH * aspect, ph = aspect >= SW / SH ? SW / aspect : SH;
  const sweepX = interpolate(f, [8, 52], [-0.4, 1.4], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});
  return (
    <AbsoluteFill style={{backgroundColor: '#0b0c0e'}}>
      <AbsoluteFill style={{transform: `scale(${1.3 + 0.06 * t}) translateX(${(t - 0.5) * 60}px)`, filter: 'blur(36px) brightness(.5)'}}>
        <img src={staticFile(photo)} style={{width: '100%', height: '100%', objectFit: 'cover'}} />
      </AbsoluteFill>
      <AbsoluteFill style={{justifyContent: 'center', alignItems: 'center'}}>
        <div style={{width: pw, height: ph, position: 'relative', overflow: 'hidden', borderRadius: 16, boxShadow: '0 40px 90px rgba(0,0,0,.6)', transform: `perspective(1800px) rotateY(${(0.5 - t) * 10}deg) scale(${1 + 0.06 * t}) translateX(${(0.5 - t) * -40}px)`}}>
          <img src={staticFile(photo)} style={{width: '100%', height: '100%', objectFit: 'cover'}} />
          <div style={{position: 'absolute', top: 0, bottom: 0, left: `${sweepX * 100}%`, width: '20%', background: 'linear-gradient(100deg, rgba(255,255,255,0) 0%, rgba(255,255,255,.3) 50%, rgba(255,255,255,0) 100%)', transform: 'skewX(-18deg)'}} />
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

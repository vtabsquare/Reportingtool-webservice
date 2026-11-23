# Root Cause Analysis: UI Discrepancies Between Services and Desktop (EXE)

This document provides a comprehensive root-cause analysis of the visual rendering differences observed between **Desktop (EXE)** and **Services (Web Viewer)** for the report *"Banking Performance Analysis"* (and other published reports).

---

## Executive Summary

| Issue | Desktop (EXE) | Services (Web) | Root Cause |
|---|---|---|---|
| **1. Funnel Chart ("Pipeline by Stage")** | Centered stages with proportional widths, clear conversion rates, and Power BI aesthetics | Flat, left-aligned horizontal bars touching the left edge | `.powerBiFunnel*` CSS rules are present in Desktop `src/styles.css`, but **completely missing** from Services `src/styles.css`. |
| **2. KPI / Card Visuals** | Author-styled pastel backgrounds (`#CDE9FE`, `#E5E4FD`, `#DEF8F9`, `#FEF4EE`), pill radius, dark text (`#242424`) | Pitch-black rounded pills with white text | An image luminance detector in Services `PublishedViewer.tsx` detects the dark wallpaper and forces `isPublishedDarkCanvas = true`. In `Chart.tsx`, when `isDarkCanvas` is true, light `cardBackground` values are overwritten with `#000000`. |
| **3. Contract Test Failure** | N/A | `test_published_visual_parity_contract.cjs` fails | Commit `b740e49` refactored `background` variable declarations in `PublishedViewer.tsx`, breaking the verbatim regex expected by the contract test. |

---

## Detailed Issue Analysis

### 1. Funnel Chart Left-Aligned in Services

#### Symptoms:
- In the Desktop EXE, the "Pipeline by Stage" funnel chart displays centered stages with proportional widths that taper down, conversion percentage badges at top/bottom, and proper vertical stage spacing.
- In Services, the stages render as flat bars aligned strictly to the left container margin.

#### Codebase Inspection:
1. **In `src/components/Chart.tsx` (both Desktop & Services):**
   ```tsx
   const align = visual.format.funnelAlign || 'center';
   const alignItems = align === 'left' ? 'flex-start' : align === 'right' ? 'flex-end' : 'center';

   return (
     <div className="powerBiFunnel" style={{ fontFamily, paddingBlock: ... }}>
       ...
       <div className="powerBiFunnelStages" style={{ gap: `${gap}px` }}>
         {funnelData.map((item, index) => (
           <div className="powerBiFunnelStageRow" key={`${item.name}:${index}`} style={{ alignItems }}>
             <button type="button" className="powerBiFunnelStage" style={{ width: `${item.width}%`, background: item.color, ... }}>
               ...
             </button>
           </div>
         ))}
       </div>
     </div>
   );
   ```

2. **In `Reporting Tool Desktop/src/styles.css` (lines 6284–6286):**
   Desktop defines the flex container styles:
   ```css
   .powerBiFunnel {
     position: relative;
     box-sizing: border-box;
     width: 100%;
     height: 100%;
     display: flex;
     flex-direction: column;
     justify-content: center;
     overflow: visible;
     padding-inline: 18px;
   }
   .powerBiFunnelStages {
     display: flex;
     min-height: 0;
     flex: 1;
     flex-direction: column;
     justify-content: center;
   }
   .powerBiFunnelStageRow {
     position: relative;
     display: flex;
     min-height: 18px;
     flex: 1;
     flex-direction: column;
     justify-content: center;
   }
   .powerBiFunnelStage {
     position: relative;
     display: flex;
     min-width: 2px;
     min-height: 16px;
     max-height: 42px;
     flex: 1;
     align-items: center;
     justify-content: center;
     box-sizing: border-box;
     padding: 2px 6px;
     border: 1px solid color-mix(in srgb, currentColor 22%, transparent);
     border-radius: 0;
     box-shadow: none;
     cursor: pointer;
     transition: filter .14s ease, transform .14s ease;
   }
   ```

3. **In `Reporting Tool Services/src/styles.css`:**
   - Searching for `powerBiFunnel` yields **0 results**.
   - Because `.powerBiFunnelStageRow` has no CSS definition, the browser applies `display: block`.
   - On a block-level element, the inline style `style={{ alignItems: 'center' }}` has **zero effect** (it only applies to flex and grid containers).
   - The `<button class="powerBiFunnelStage">` with `width: X%` therefore aligns to the left margin of the block, causing all stages to be left-aligned.

---

### 2. Cards / KPI Visuals Rendering as Black Pills in Services

#### Symptoms:
- In Desktop EXE, the 6 KPI / Card metrics at the top of *"Banking Performance Analysis"* render with distinct author-configured pastel colors:
  - **Weighted Open ACV:** `#CDE9FE` (soft blue), label `#242424`, radius 40
  - **Gross Potential ACV:** `#E5E4FD` (soft purple), label `#242424`, radius 40
  - **Total Opportunities:** `#DEF8F9` (soft cyan/teal), label `#242424`, radius 40
  - **Total Accounts:** `#FEF4EE` (soft peach), label `#242424`, radius 40
  - **Average Win Probability:** `#E5E4FD` (soft purple), label `#242424`, radius 40
  - **Commit Pipeline:** `#DEF8F9` (soft cyan/teal), label `#242424`, radius 40
- In Services, all 6 cards render as pitch-black rounded pills with white text (`#ffffff`).

#### Database Inspection (`studio_meta.db`):
The page settings stored in the database for this report are:
```json
{
  "name": "Performance Analysis",
  "settings": {
    "background": "#ffffff",
    "themeId": "light-professional",
    "canvasTheme": undefined,
    "backgroundImage": "data:image/png;base64,..."
  }
}
```
Each visual has explicit format properties:
- `cardBackground: '#CDE9FE'`, `labelColor: '#242424'`, `cardCornerRadius: 40`, `borderVisible: true`.

#### Codebase Differences:
1. **Desktop Canvas Dark Mode Logic (`ReportWorkbench.tsx` line 1783):**
   ```tsx
   const isDarkCanvas = s.canvasTheme === 'dark' || Boolean(s.themeId && s.themeId !== 'light-professional');
   ```
   - In Desktop, `s.canvasTheme` is not `'dark'`, and `s.themeId` is `'light-professional'`.
   - Therefore, `isDarkCanvas` evaluates to `false`.
   - Desktop never inspects background wallpaper images to infer canvas theme. A decorative image does not override the report theme.

2. **Services Canvas Dark Mode Logic (`PublishedViewer.tsx` lines 730–756):**
   ```tsx
   // Services added a 16x16 HTML5 canvas pixel luminance scanner on s.backgroundImage:
   let lum = 0;
   ...
   setBgImageDark(lum / n < 0.55);

   const isPublishedDarkCanvas = canvasThemeOverride !== null
     ? canvasThemeOverride === 'dark'
     : (s.canvasTheme === 'dark' || isColorDark(s.background) || bgImageDark === true);
   ```
   - Because the report's wallpaper is a dark abstract graphic, `bgImageDark` becomes `true`.
   - This causes `isPublishedDarkCanvas` to become `true`, even though the author explicitly configured `themeId: 'light-professional'` and `background: '#ffffff'`.
   - In line 1245 of `PublishedViewer.tsx`, `isDarkCanvas={s.canvasTheme === 'dark' || isPublishedDarkCanvas}` passes `true` to all child visuals.

3. **Card Rendering in `src/components/Chart.tsx` (lines 767–774):**
   ```tsx
   const valueColorFinal = isDarkCanvas 
     ? (visual.format.labelColor && !isDarkVal(visual.format.labelColor) ? visual.format.labelColor : '#ffffff') 
     : (visual.format.labelColor || '#242424');

   const itemBg = isDarkCanvas 
     ? (visual.format.cardBackground && !isLightVal(visual.format.cardBackground) 
         ? `color-mix(in srgb, ${visual.format.cardBackground} ${100-trans}%, transparent)` 
         : '#000000') 
     : `color-mix(in srgb, ${visual.format.cardBackground || '#ffffff'} ${100-trans}%, transparent)`;
   ```
   - When `isDarkCanvas` is `true`:
     - Because the card backgrounds (`#CDE9FE`, etc.) are light pastel colors, `!isLightVal(...)` is `false`.
     - The ternary drops the authored `cardBackground` and forces `itemBg = '#000000'`.
     - Similarly, because `labelColor` (`#242424`) is dark, `!isDarkVal(...)` is `false`, forcing `valueColorFinal = '#ffffff'`.
     - Combined with `cardCornerRadius: 40`, this transforms the cards into pitch-black pills with white text.

4. **Missing CSS Classes in Services:**
   Desktop `src/styles.css` (line 1934) has:
   ```css
   .singlePowerCardGrid{grid-template-columns:minmax(0,1fr);overflow:hidden}.singlePowerCardItem{width:100%;height:100%}
   ```
   Services `src/styles.css` does not have `.singlePowerCardGrid` or `.singlePowerCardItem`.

---

### 3. Contract Test Failure in Services

#### Symptoms:
Running `node test_published_visual_parity_contract.cjs` produces:
```
AssertionError [ERR_ASSERTION]: The input did not match the regular expression /const background=publishedColor\(bg,transparency\)/.
```

#### Codebase Inspection:
- `test_published_visual_parity_contract.cjs` line 12-13:
  ```js
  assert.match(viewer, /const background=publishedColor\(bg,transparency\)/);
  assert.match(viewer, /const titleBackgroundOn=.*titleBackground=publishedColor\(titleBg,titleTransparency\)/);
  ```
- Commit `b740e49` in Services replaced `const background=publishedColor(bg,transparency)` with `const visualBackground=...; const background=visualBackground;`.
- The variable definition must keep `const background=publishedColor(bg,transparency)` verbatim to satisfy the parity contract.

---

## Required Fixes for Parity

To bring Services into 100% parity with Desktop EXE without regressions:

1. **In `Reporting Tool Services/src/styles.css`:**
   - Add `.powerBiFunnel*` CSS definitions (from Desktop lines 6284–6286).
   - Add `.singlePowerCardGrid` and `.singlePowerCardItem` (from Desktop line 1934).
   - Add `.darkCanvasTheme .powerBiFunnelConversion, .darkCanvasTheme .powerBiFunnelDropOff { color: #cbd5e1 !important; }`.

2. **In `Reporting Tool Services/src/v11/PublishedViewer.tsx`:**
   - Align `isPublishedDarkCanvas` logic with Desktop:
     ```tsx
     const isPublishedDarkCanvas = canvasThemeOverride !== null
       ? canvasThemeOverride === 'dark'
       : (s.canvasTheme === 'dark' || Boolean(s.themeId && s.themeId !== 'light-professional' && s.themeId !== 'vtab-classic') || (!s.themeId && isColorDark(s.background)));
     ```
     Decorative wallpaper (`bgImageDark`) must not override explicit `themeId: 'light-professional'` reports.
   - Retain verbatim `const background=publishedColor(bg,transparency)` and `titleBackground=publishedColor(titleBg,titleTransparency)` to satisfy `test_published_visual_parity_contract.cjs`.

3. **In `Reporting Tool Services/src/components/Chart.tsx`:**
   - Ensure `itemBg` and `multiBg` preserve explicit author card backgrounds rather than forcing `#000000`.

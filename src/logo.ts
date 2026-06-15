/**
 * Unabyss brand mark, rendered as inline SVG so the plugin ships no
 * external image assets (Obsidian only downloads main.js / manifest.json
 * / styles.css from a release).
 *
 * Two consumers:
 *  - {@link renderUnabyssLogo} draws the full brand tile (rounded square
 *    background + 4x4 opacity-graded dot grid) into a DOM parent. Tile
 *    and dot colours come from CSS custom properties so the mark adapts
 *    to the active light / dark theme.
 *  - {@link UNABYSS_ICON_SVG} is a monochrome (currentColor) variant
 *    registered via Obsidian's ``addIcon`` for the sidebar view tab.
 */

/** Per-dot opacity grid (row-major, 4x4) taken from the brand logo-1. */
const DOT_OPACITIES = [
    0.28, 0.26, 0.89, 0.65,
    0.56, 0.7, 0.88, 0.69,
    0.57, 0.26, 0.62, 0.5,
    0.74, 0.08, 0.13, 0.98,
];

/** Icon id registered with ``addIcon`` and returned from the view's getIcon. */
export const UNABYSS_ICON_ID = "unabyss-logo";

/**
 * Draws the themed brand tile into ``parent``. The returned element is
 * the <svg> so callers can size it via CSS if needed.
 */
export function renderUnabyssLogo(parent: HTMLElement, extraClass?: string): SVGElement {
    const coords = [4, 12, 20, 28];
    const svg = parent.createSvg("svg", {
        cls: extraClass ? `unabyss-logo ${extraClass}` : "unabyss-logo",
        attr: { viewBox: "0 0 32 32", width: 32, height: 32 },
    });
    svg.createSvg("rect", {
        cls: "unabyss-logo-tile",
        attr: { x: 0, y: 0, width: 32, height: 32, rx: 7 },
    });
    let index = 0;
    for (const cy of coords) {
        for (const cx of coords) {
            svg.createSvg("circle", {
                cls: "unabyss-logo-dot",
                attr: { cx, cy, r: 3, "fill-opacity": DOT_OPACITIES[index] },
            });
            index++;
        }
    }
    return svg;
}

/**
 * Builds the monochrome icon body for ``addIcon`` (Obsidian wraps it in a
 * 0 0 100 100 viewBox and tints with currentColor).
 */
function buildIconSvg(): string {
    const coords = [12.5, 37.5, 62.5, 87.5];
    let circles = "";
    let index = 0;
    for (const cy of coords) {
        for (const cx of coords) {
            circles += `<circle cx="${cx}" cy="${cy}" r="9.4" fill="currentColor" opacity="${DOT_OPACITIES[index]}"/>`;
            index++;
        }
    }
    return `<g>${circles}</g>`;
}

export const UNABYSS_ICON_SVG = buildIconSvg();

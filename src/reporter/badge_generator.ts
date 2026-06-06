/**
 * @file badge_generator.ts
 * @description Generates static SVG badges representing build status and performance.
 */

export class BadgeGenerator {
    /**
     * Generate a Shields.io-style SVG badge string.
     * Uses a terminal aesthetic: #00FF00 (Hex Green) on #1A1A1A (Vanta Black).
     * 
     * @param hoursSaved Precise hours of TEI recovered
     * @returns SVG XML string
     */
    static generate(hoursSaved: number): string {
        const valueStr = hoursSaved === 0
            ? "0.0h Recovered"
            : `${hoursSaved.toFixed(1)}h Recovered`;

        // SVGs require precise string length offsets. 
        // We do a simple estimation here for character widths.
        const labelWidth = 85;
        const valueWidth = valueStr.length * 7 + 10;
        const totalWidth = labelWidth + valueWidth;
        const valueX = labelWidth + (valueWidth / 2);

        return `\
<svg xmlns="http://www.w3.org/2000/svg" width="${totalWidth}" height="20" role="img" aria-label="Core: ${valueStr}">
  <title>Core: ${valueStr}</title>
  <linearGradient id="s" x2="0" y2="100%">
    <stop offset="0" stop-color="#bbb" stop-opacity=".1"/>
    <stop offset="1" stop-opacity=".1"/>
  </linearGradient>
  <clipPath id="r">
    <rect width="${totalWidth}" height="20" rx="3" fill="#fff"/>
  </clipPath>
  <g clip-path="url(#r)">
    <rect width="${labelWidth}" height="20" fill="#1A1A1A"/>
    <rect x="${labelWidth}" width="${valueWidth}" height="20" fill="#1A1A1A"/>
    <rect width="${totalWidth}" height="20" fill="url(#s)"/>
  </g>
  <g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" text-rendering="geometricPrecision" font-size="110">
    <text aria-hidden="true" x="435" y="150" fill="#010101" fill-opacity=".3" transform="scale(.1)" textLength="650">Core</text>
    <text x="435" y="140" transform="scale(.1)" fill="#ffffff" textLength="650">Core</text>
    
    <text aria-hidden="true" x="${valueX * 10}" y="150" fill="#010101" fill-opacity=".3" transform="scale(.1)" textLength="${valueWidth * 10 - 200}">${valueStr}</text>
    <text x="${valueX * 10}" y="140" transform="scale(.1)" fill="#00FF00" textLength="${valueWidth * 10 - 200}">${valueStr}</text>
  </g>
</svg>
`;
    }
}

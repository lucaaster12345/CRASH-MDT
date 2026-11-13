# AI design rules (anti-slop)

Drop this into your project so your coding agent stops reaching for the same defaults every AI build converges on. Rename it to whatever your tool reads: `CLAUDE.md`, `.cursorrules`, `AGENTS.md`, or paste it into a system prompt.

This is a bias corrector, not a ban list. The goal is not to forbid these patterns, it is to stop the model from reaching for all of them by reflex. Every item below is a legitimate choice in the right context. The rule is: make it a decision, not a default. When one of these fits the actual brand or problem, use it on purpose and say why.

## Core principle

You default to the statistical median of your training data whenever a design choice is left unspecified. That median is the "AI look." Before shipping any UI, assume your first instinct for color, type, and layout is that median, and make one deliberate departure from it.

## Color

- Do not default to an indigo or purple gradient (the Tailwind `indigo-500` / `violet-500` reflex). Pick a palette from the actual brand. If there is no brand, choose one committed accent and justify it, rather than a gradient of two adjacent hues.
- Do not fall back to emerald or cream just because purple is off the table. Those are the second-wave defaults now.
- Avoid neon-on-near-black with colored glow shadows unless the product genuinely calls for a dark developer aesthetic.
- Use one dominant color with a real accent, not four muted colors at equal weight.
- Do not apply gradient fills to headings or numbers as decoration.

## Typography

- Inter, Geist, and Space Grotesk are fine typefaces but they are the defaults everyone ships. Choose type from the brand. If you use Inter, that should be a decision, not the absence of one.
- Do not reach for an oversized italic serif hero headline (Instrument Serif and friends) unless the register is genuinely editorial.
- Build a real type scale with clear steps. Do not set the whole page in one family at one weight.
- Do not crush letter spacing on display type or set body copy in a monospace font for "hacker" flavor.

## Layout and hero

- Do not emit the default hero: centered eyebrow pill, oversized centered headline, two buttons (gradient primary reading "Get Started" plus ghost secondary), gradient orb behind. If you build a centered hero, vary it.
- Do not resolve every feature section into exactly three equal cards with an icon on top. Let the content decide the count and shape. A bento grid is now the same reflex, so it does not count as escaping this.
- Avoid the full template waterfall in fixed order (hero, logo wall, three cards, testimonial carousel, stats row, pricing, FAQ, footer CTA). Cut or reorder sections to fit the actual story.
- Do not invent trust content: no fabricated user counts ("Trusted by 5,000+ teams"), no placeholder client logo walls, no testimonials from people who do not exist. Leave these out until there is real content.
- Vary spacing for rhythm and emphasis. Do not apply one uniform section padding everywhere.

## Components and surfaces

- Do not apply one large border radius (`rounded-2xl`) to every card, input, button, and image. Vary radius by element.
- If you use a component library (shadcn and similar), override the default theme tokens. Shipping the untouched defaults is the tell.
- Do not pair a hairline border with a wide diffuse shadow on the same card. Commit to one edge treatment.
- Do not put a decorative colored strip on the left border of ordinary cards. That treatment belongs to semantic alerts.
- Avoid frosted glassmorphism where there is no real layering problem to solve.

## Icons and imagery

- Do not use the same five Lucide icons across unrelated concepts (Sparkles for AI, Zap for fast, Shield for secure). Pick icons that match the specific meaning, or use none.
- Never use emoji as feature-card or section icons in a product UI.
- Do not use a fake terminal window with macOS traffic-light dots as the hero visual unless it is a developer tool showing real output.
- If you generate images, avoid the giveaways: the warm yellow cast, waxy poreless skin, garbled small text in the background, hands under load. Prefer real photography or commissioned art when it matters.

## Motion

- Do not apply the same fade-up-on-scroll to every element. Use motion where it communicates something.
- Avoid bounce and elastic easing. Keep transitions coherent across the interface instead of animating each element in isolation.

## Copy

- Do not write the weightless headline that could describe any product ("Build faster. Ship smarter."). Say what this specific product does.
- Strip the buzzword layer: streamline, supercharge, empower, world-class, enterprise-grade, seamless, robust, unlock, unleash, "in today's fast-paced world."
- Do not overuse the em dash, the "it's not just X, it's Y" pivot, or a manufactured-contrast aphorism at the end of every section.
- Do not set every heading, button, and label in Title Case out of reflex. Pick a case convention and apply it with intent.

## The one rule

No single item above matters on its own. The AI look is the co-occurrence of many of these defaults at once with no deliberate choice anywhere. Ship a design where the important decisions were made on purpose, and it will not read as generated even if it happens to use a rounded card or a sans-serif font.

import { logger, schedules } from "@trigger.dev/sdk/v3";
import Anthropic from "@anthropic-ai/sdk";

// ─── Config ───────────────────────────────────────────────────────────────────
const AI_MODEL = "claude-haiku-4-5-20251001";
const FACEBOOK_API_VERSION = "v19.0";
const RAPIDAPI_HOST = "hotels-com-provider.p.rapidapi.com";

// ─── Types ────────────────────────────────────────────────────────────────────
interface HotelDeal {
  name: string;
  price: number;
  originalPrice?: number;
  rating?: number;
  reviewCount?: number;
  amenities: string[];
  affiliateLink: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function getDateRange(): { checkIn: string; checkOut: string } {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const dayAfter = new Date();
  dayAfter.setDate(dayAfter.getDate() + 2);
  const fmt = (d: Date) => d.toISOString().split("T")[0];
  return { checkIn: fmt(tomorrow), checkOut: fmt(dayAfter) };
}

function buildAffiliateLink(
  location: string,
  checkIn: string,
  checkOut: string,
  affiliateId: string
): string {
  const dest = encodeURIComponent(location);
  return `https://www.expedia.com/Hotel-Search?destination=${dest}&startDate=${checkIn}&endDate=${checkOut}&AFFCID=${affiliateId}`;
}

// ─── Hotel Search ─────────────────────────────────────────────────────────────
async function getRegionId(
  location: string,
  apiKey: string
): Promise<string | null> {
  try {
    const res = await fetch(
      `https://${RAPIDAPI_HOST}/v2/regions?query=${encodeURIComponent(
        location
      )}&locale=en_US&siteid=300000001`,
      {
        headers: {
          "X-RapidAPI-Key": apiKey,
          "X-RapidAPI-Host": RAPIDAPI_HOST,
        },
      }
    );
    if (!res.ok) return null;
    const data = await res.json();
    const regions: any[] = data?.data ?? [];
    const region =
      regions.find(
        (r: any) =>
          r.type === "CITY" ||
          r.type === "NEIGHBORHOOD" ||
          r.type === "AIRPORT"
      ) ?? regions[0];
    return region?.gaiaId ?? null;
  } catch (e) {
    logger.warn(`Region search failed for ${location}: ${e}`);
    return null;
  }
}

async function searchHotels(
  regionId: string,
  checkIn: string,
  checkOut: string,
  apiKey: string
): Promise<any[]> {
  try {
    const url =
      `https://${RAPIDAPI_HOST}/v2/hotels/search` +
      `?regionId=${regionId}&locale=en_US&siteid=300000001` +
      `&checkIn=${checkIn}&checkOut=${checkOut}` +
      `&adults=2&rooms=1&resultsSize=15&sort=PRICE_LOW_TO_HIGH&currency=USD`;
    const res = await fetch(url, {
      headers: {
        "X-RapidAPI-Key": apiKey,
        "X-RapidAPI-Host": RAPIDAPI_HOST,
      },
    });
    if (!res.ok) return [];
    const data = await res.json();
    return data?.properties ?? [];
  } catch (e) {
    logger.warn(`Hotel search failed: ${e}`);
    return [];
  }
}

// ─── Facebook Post Writer ─────────────────────────────────────────────────────
// OPENER STYLES — rotated randomly. "You know that feeling" is banned.
const OPENER_STYLES = [
  "Start with the specific nightly price as the hook — e.g., '$119 a night, right on the Gulf.'",
  "Open with a vivid sensory scene — e.g., 'White sand, warm water, nowhere to be.'",
  "Open with a direct curiosity-sparking question — e.g., 'Still haven't locked in that summer trip?'",
  "Start with casual friend-to-friend energy — e.g., 'Not gonna lie, this one caught our eye.'",
  "Lead with a local insider tip — e.g., 'If you know Gulf Shores, you know timing is everything.'",
  "Open with the hotel name and one compelling fact about it.",
  "Start with a short punchy urgency line — e.g., 'Rates just dropped for this weekend.'",
  "Open with a lifestyle statement about what this trip would actually feel like.",
  "Lead with the deal savings front and center — e.g., 'They knocked 25% off the rate and it's still open.'",
  "Start with social proof — e.g., 'One of Gulf Shores' top-rated beachfront hotels just opened up availability.'",
  "Open with a time-sensitive angle — e.g., 'Last-minute weekend plans? This one's still available.'",
  "Start with something specific about the Gulf Coast — the sugar-white sand, the emerald water, the vibe.",
];

async function generateFacebookPost(
  deal: HotelDeal,
  location: string,
  client: Anthropic
): Promise<string> {
  const openerStyle =
    OPENER_STYLES[Math.floor(Math.random() * OPENER_STYLES.length)];

  const savings =
    deal.originalPrice && deal.originalPrice > deal.price
      ? `${Math.round((1 - deal.price / deal.originalPrice) * 100)}% off the regular rate`
      : null;

  const prompt = `You write Facebook posts for a hotel deals page covering ${location} travel on the Alabama Gulf Coast.

Hotel deal:
- Hotel: ${deal.name}
- Price: $${deal.price}/night
${savings ? `- Savings: ${savings}` : ""}
${deal.rating ? `- Rating: ${deal.rating}/5 (${deal.reviewCount?.toLocaleString()} reviews)` : ""}
${deal.amenities.length > 0 ? `- Amenities: ${deal.amenities.slice(0, 4).join(", ")}` : ""}
- Booking link: ${deal.affiliateLink}

Write one Facebook post. Follow these rules exactly:

1. NEVER use "You know that feeling" — not at the start, not anywhere. This phrase is banned.
2. Use this opener style: ${openerStyle}
3. Keep it conversational and genuine — like a friend texting you about a good find.
4. Include the booking link at the end.
5. 3–5 sentences max. No essays.
6. 1–2 emojis only, placed naturally — do not overload.
7. No hashtags.
8. Make it feel specific to the Alabama Gulf Coast, not generic.

Output only the post text. Nothing else.`;

  const msg = await client.messages.create({
    model: AI_MODEL,
    max_tokens: 400,
    messages: [{ role: "user", content: prompt }],
  });

  const text = msg.content[0].type === "text" ? msg.content[0].text.trim() : "";
  if (!text) throw new Error("Claude returned empty post text");
  return text;
}

async function postToFacebook(
  text: string,
  fbPageId: string,
  fbToken: string
): Promise<string> {
  const res = await fetch(
    `https://graph.facebook.com/${FACEBOOK_API_VERSION}/${fbPageId}/feed`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: text,
        access_token: fbToken,
      }),
    }
  );
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Facebook API error ${res.status}: ${err}`);
  }
  const data = await res.json();
  return data.id;
}

// ─── Shared Run Logic ─────────────────────────────────────────────────────────
async function runBotForLocation(location: string): Promise<void> {
  const rapidApiKey = process.env.RAPIDAPI_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const fbPageId = process.env.FACEBOOK_PAGE_ID;
  const fbToken = process.env.FACEBOOK_PAGE_ACCESS_TOKEN;
  const affId = process.env.EXPEDIA_AFFILIATE_ID ?? "1100l395625";

  if (!rapidApiKey || !anthropicKey || !fbPageId || !fbToken) {
    logger.error("Missing required environment variables");
    return;
  }

  const aiClient = new Anthropic({ apiKey: anthropicKey });
  const { checkIn, checkOut } = getDateRange();

  logger.log(`Searching hotels for ${location}`, { checkIn, checkOut });

  const regionId = await getRegionId(location, rapidApiKey);
  if (!regionId) {
    logger.error(`Could not find region ID for: ${location}`);
    return;
  }

  const hotels = await searchHotels(regionId, checkIn, checkOut, rapidApiKey);
  if (hotels.length === 0) {
    logger.warn(`No hotels found for ${location}`);
    return;
  }

  const rated = hotels.filter(
    (h: any) => h.price?.lead?.amount && (h.reviews?.score ?? 0) >= 3.5
  );
  const best = rated.length > 0
    ? rated.sort((a: any, b: any) => a.price.lead.amount - b.price.lead.amount)[0]
    : hotels[0];

  const deal: HotelDeal = {
    name: best.name ?? "Featured Hotel",
    price: Math.round(best.price?.lead?.amount ?? 0),
    originalPrice: best.price?.strikeThrough?.amount
      ? Math.round(best.price.strikeThrough.amount)
      : undefined,
    rating: best.reviews?.score,
    reviewCount: best.reviews?.total,
    amenities: (best.amenities ?? [])
      .slice(0, 5)
      .map((a: any) => (typeof a === "string" ? a : a.text ?? "")),
    affiliateLink: buildAffiliateLink(location, checkIn, checkOut, affId),
  };

  logger.log("Best deal selected", { hotel: deal.name, price: deal.price });

  const postText = await generateFacebookPost(deal, location, aiClient);
  logger.log("Generated post", { postText });

  const postId = await postToFacebook(postText, fbPageId, fbToken);
  logger.log(`✅ Posted to Facebook`, { postId, location });
}

// ─── Scheduled Tasks ──────────────────────────────────────────────────────────

// 9am CT — Gulf Shores, AL
export const hotelBotMorning = schedules.task({
  id: "hotel-facebook-bot-morning",
  cron: {
    pattern: "0 9 * * *",
    timezone: "America/Chicago",
  },
  maxDuration: 120,
  run: async (payload) => {
    logger.log("🏖️ Morning bot running — Gulf Shores, AL", {
      at: payload.timestamp.toISOString(),
    });
    await runBotForLocation("Gulf Shores, Alabama");
  },
});

// 2pm CT — Orange Beach, AL
export const hotelBotAfternoon = schedules.task({
  id: "hotel-facebook-bot-afternoon",
  cron: {
    pattern: "0 14 * * *",
    timezone: "America/Chicago",
  },
  maxDuration: 120,
  run: async (payload) => {
    logger.log("🌊 Afternoon bot running — Orange Beach, AL", {
      at: payload.timestamp.toISOString(),
    });
    await runBotForLocation("Orange Beach, Alabama");
  },
});

import { logger, schedules } from "@trigger.dev/sdk/v3";
import Anthropic from "@anthropic-ai/sdk";

// ─── Config ───────────────────────────────────────────────────────────────────
const AI_MODEL = "claude-haiku-4-5-20251001";
const FACEBOOK_API_VERSION = "v19.0";
const RAPIDAPI_HOST = "booking-com15.p.rapidapi.com";

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

// ─── Hotel Search (Booking COM by DataCrawler — booking-com15.p.rapidapi.com) ─
async function getDestination(
  location: string,
  apiKey: string
): Promise<{ destId: string; searchType: string } | null> {
  const searchTerms = [
    location,
    location.split(",")[0].trim(),
  ];

  for (const term of searchTerms) {
    try {
      logger.log(`Trying destination search: "${term}"`);
      const res = await fetch(
        `https://${RAPIDAPI_HOST}/api/v1/hotels/searchDestination?query=${encodeURIComponent(term)}&languagecode=en-us`,
        {
          headers: {
            "X-RapidAPI-Key": apiKey,
            "X-RapidAPI-Host": RAPIDAPI_HOST,
          },
        }
      );
      if (!res.ok) {
        const errBody = await res.text().catch(() => "");
        logger.warn(`Destination API HTTP ${res.status} for "${term}": ${errBody.slice(0, 300)}`);
        continue;
      }
      const data = await res.json();
      const results: any[] = data?.data ?? [];
      logger.log(`Destination results for "${term}": ${results.length} found`);

      if (results.length > 0) {
        logger.log(`First result: ${JSON.stringify(results[0]).slice(0, 200)}`);
      }

      const match =
        results.find((r: any) => r.search_type === "city" || r.dest_type === "city") ??
        results[0];

      if (match) {
        const destId = match.dest_id ?? match.destId;
        const searchType = match.search_type ?? match.dest_type ?? "city";
        if (destId) {
          logger.log(`Found destination: id=${destId} type=${searchType} label=${match.label ?? match.city_name ?? ""}`);
          return { destId: String(destId), searchType };
        }
      }
    } catch (e) {
      logger.warn(`Destination search failed for "${term}": ${e}`);
    }
  }
  return null;
}

async function searchHotels(
  destId: string,
  searchType: string,
  checkIn: string,
  checkOut: string,
  apiKey: string
): Promise<any[]> {
  try {
    const params = new URLSearchParams({
      dest_id: destId,
      search_type: searchType,
      arrival_date: checkIn,
      departure_date: checkOut,
      adults: "2",
      room_qty: "1",
      page_number: "1",
      currency_code: "USD",
      languagecode: "en-us",
    });
    const url = `https://${RAPIDAPI_HOST}/api/v1/hotels/searchHotels?${params}`;
    const res = await fetch(url, {
      headers: {
        "X-RapidAPI-Key": apiKey,
        "X-RapidAPI-Host": RAPIDAPI_HOST,
      },
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      logger.warn(`Hotel search HTTP ${res.status}: ${errBody.slice(0, 300)}`);
      return [];
    }
    const data = await res.json();
    const hotels = data?.data?.hotels ?? data?.data ?? [];
    logger.log(`Hotel search returned ${hotels.length} hotels`);
    if (hotels.length > 0) {
      logger.log(`First hotel sample: ${JSON.stringify(hotels[0]).slice(0, 300)}`);
    }
    return hotels;
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
${deal.rating ? `- Rating: ${deal.rating}/10 (${deal.reviewCount?.toLocaleString()} reviews)` : ""}
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

// ─── Generic Discovery Post (fallback when hotel API fails) ───────────────────
async function postGenericDiscovery(
  location: string,
  checkIn: string,
  checkOut: string,
  affId: string,
  client: Anthropic,
  fbPageId: string,
  fbToken: string
): Promise<void> {
  const searchLink = buildAffiliateLink(location, checkIn, checkOut, affId);
  const openerStyle =
    OPENER_STYLES[Math.floor(Math.random() * OPENER_STYLES.length)];

  const prompt = `You write Facebook posts for a hotel deals page covering ${location} travel on the Alabama Gulf Coast.

Write one short Facebook post encouraging people to check out hotel deals in ${location} for the coming days.
Use this affiliate search link: ${searchLink}

Rules:
1. NEVER use "You know that feeling" — banned everywhere.
2. Use this opener style: ${openerStyle}
3. Keep it casual and genuine — like a friend texting a tip.
4. Include the search link at the end.
5. 2–4 sentences. Keep it punchy.
6. 1–2 emojis only.
7. No hashtags.
8. Make it feel specific to ${location} and the Alabama Gulf Coast.

Output only the post text. Nothing else.`;

  const msg = await client.messages.create({
    model: AI_MODEL,
    max_tokens: 300,
    messages: [{ role: "user", content: prompt }],
  });

  const text = msg.content[0].type === "text" ? msg.content[0].text.trim() : "";
  if (!text) {
    logger.error("Claude returned empty text for generic post");
    return;
  }

  logger.log("Generated generic discovery post", { text });
  const postId = await postToFacebook(text, fbPageId, fbToken);
  logger.log("✅ Posted generic discovery post", { postId, location });
}

async function postToFacebook(
  text: string,
  fbPageId: string,
  fbToken: string,
  photoUrl?: string | null
): Promise<string> {
  // If we have a photo URL, post via /photos endpoint
  if (photoUrl) {
    logger.log(`Posting with photo: ${photoUrl}`);
    const res = await fetch(
      `https://graph.facebook.com/${FACEBOOK_API_VERSION}/${fbPageId}/photos`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: photoUrl,
          caption: text,
          access_token: fbToken,
        }),
      }
    );
    if (!res.ok) {
      const err = await res.text();
      logger.warn(`Photo post failed (${res.status}): ${err.slice(0, 200)} — falling back to text-only`);
      // Fall through to text-only post below
    } else {
      const data = await res.json();
      return data.post_id ?? data.id;
    }
  }

  // Text-only fallback
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

// ─── Extract price, rating, and photo from DataCrawler hotel object ──────────
function extractHotelData(h: any): { price: number; rating: number; reviewCount: number; photoUrl: string | null } {
  const price =
    h.property?.priceBreakdown?.grossPrice?.value ??
    h.property?.priceBreakdown?.strikethroughPrice?.value ??
    h.priceBreakdown?.grossPrice?.value ??
    h.min_total_price ??
    h.price ??
    0;

  const rating =
    h.property?.reviewScore ??
    h.review_score ??
    h.reviewScore ??
    0;

  const reviewCount =
    h.property?.reviewCount ??
    h.review_nr ??
    h.reviewCount ??
    0;

  // Try every known field name DataCrawler uses for photos
  const photoUrl =
    h.property?.photoUrls?.[0] ??
    h.property?.mainPhoto?.highResUrl ??
    h.property?.mainPhoto?.lowResUrl ??
    h.property?.mainPhoto?.url ??
    h.photoUrls?.[0] ??
    h.mainPhoto?.highResUrl ??
    h.mainPhoto?.url ??
    h.photo?.url ??
    null;

  return { price: Math.round(price), rating, reviewCount, photoUrl };
}

// ─── Shared Run Logic ─────────────────────────────────────────────────────────
async function runBotForLocation(location: string): Promise<void> {
  const rapidApiKey = process.env.RAPIDAPI_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const fbPageId = process.env.FACEBOOK_PAGE_ID;
  const fbToken = process.env.FACEBOOK_PAGE_ACCESS_TOKEN;
  const affId = process.env.EXPEDIA_AFFILIATE_ID ?? "1100l395625";

  if (!rapidApiKey || !anthropicKey || !fbPageId || !fbToken) {
    logger.error("Missing required environment variables — check Trigger.dev settings");
    return;
  }

  const aiClient = new Anthropic({ apiKey: anthropicKey });
  const { checkIn, checkOut } = getDateRange();

  logger.log(`Searching hotels for ${location}`, { checkIn, checkOut });

  // 1. Get destination ID
  const destination = await getDestination(location, rapidApiKey);
  if (!destination) {
    logger.warn(`Could not find destination for: ${location} — falling back to generic discovery post`);
    await postGenericDiscovery(location, checkIn, checkOut, affId, aiClient, fbPageId, fbToken);
    return;
  }

  // 2. Search hotels
  const hotels = await searchHotels(destination.destId, destination.searchType, checkIn, checkOut, rapidApiKey);
  if (hotels.length === 0) {
    logger.warn(`No hotels found for ${location} — falling back to generic discovery post`);
    await postGenericDiscovery(location, checkIn, checkOut, affId, aiClient, fbPageId, fbToken);
    return;
  }

  // 3. Pick best deal — lowest price with rating ≥ 7
  const withPrice = hotels.filter((h: any) => extractHotelData(h).price > 0);
  const rated = withPrice.filter((h: any) => extractHotelData(h).rating >= 7);
  const pool = rated.length > 0 ? rated : withPrice;
  const best = pool.sort((a: any, b: any) => extractHotelData(a).price - extractHotelData(b).price)[0];

  const { price, rating, reviewCount, photoUrl } = extractHotelData(best);
  const name = best.property?.name ?? best.hotel_name ?? best.name ?? "Featured Hotel";

  logger.log(`Photo URL found: ${photoUrl ?? "none"}`);

  const deal: HotelDeal = {
    name,
    price,
    rating,
    reviewCount,
    amenities: [],
    affiliateLink: buildAffiliateLink(location, checkIn, checkOut, affId),
  };

  logger.log("Best deal selected", { hotel: deal.name, price: deal.price, rating: deal.rating });

  // 4. Generate post
  const postText = await generateFacebookPost(deal, location, aiClient);
  logger.log("Generated post text", { postText });

  // 5. Post to Facebook (with photo if available)
  const postId = await postToFacebook(postText, fbPageId, fbToken, photoUrl);
  logger.log(`✅ Posted to Facebook`, { postId, location, hasPhoto: !!photoUrl });
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

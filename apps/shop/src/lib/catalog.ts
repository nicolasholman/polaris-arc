/**
 * The Halcyon catalogue. Prices are integer cents. The server prices every
 * order from this file; the browser's cart only ever holds ids.
 */

export type Category = "audio" | "home" | "objects" | "coffee";

export interface ProductOption {
  id: string;
  label: string;
}

export interface Product {
  id: string;
  slug: string;
  name: string;
  category: Category;
  /** Integer cents. For a subscription, per period. */
  price: number;
  recurring?: { interval: "month" };
  image: string;
  imageAlt: string;
  tagline: string;
  description: string[];
  optionLabel: string;
  options: ProductOption[];
  /** Which option the photograph shows. */
  shownIn?: string;
  specs: { label: string; value: string }[];
  badge?: string;
  /** The delivery line on the product page, when it isn't the store's usual one. */
  delivery?: string;
}

/**
 * Each category's tile is a detail of a photograph, not a product cut-out
 * already shown above it: where to look (a CSS object-position and the
 * transform origin) and how near.
 */
export interface CategoryCrop {
  x: number;
  y: number;
  zoom: number;
}

export const CATEGORIES: { id: Category; name: string; blurb: string; image: string; crop: CategoryCrop }[] = [
  // The room scene: Halcyon One resting on the lounge chair.
  { id: "audio", name: "Audio", blurb: "Headphones and speakers, tuned for long listening.", image: "/products/hero.jpg", crop: { x: 88, y: 58, zoom: 1.55 } },
  // The corner: the chair, the side table and the Arc lamp.
  { id: "home", name: "Home", blurb: "Light and seating for the room you spend the evening in.", image: "/products/hero.jpg", crop: { x: 70, y: 50, zoom: 1 } },
  // The instant camera on the side table.
  { id: "objects", name: "Objects", blurb: "The things on the desk and by the door.", image: "/products/hero.jpg", crop: { x: 62, y: 40, zoom: 2.3 } },
  // The bag's label, close.
  { id: "coffee", name: "Coffee Club", blurb: "A fresh bag from a small roaster, every month.", image: "/products/coffee.png", crop: { x: 44, y: 48, zoom: 1.45 } },
];

export const PRODUCTS: Product[] = [
  {
    id: "halcyon-one",
    slug: "halcyon-one",
    name: "Halcyon One",
    category: "audio",
    price: 34900,
    image: "/products/headphones.png",
    imageAlt: "Halcyon One over-ear headphones in graphite, with grey knit ear cushions",
    tagline: "Wireless headphones that know when to be quiet.",
    description: [
      "Adaptive noise cancelling listens to the room and gives you back the silence. Forty hours on a charge, memory-foam cushions wrapped in a wool-blend knit, and a sound tuned for long evenings rather than loud ones.",
      "They fold flat into a knit case, pair with two devices at once, and pause when you lift an ear cup.",
    ],
    optionLabel: "Colour",
    options: [
      { id: "graphite", label: "Graphite" },
      { id: "chalk", label: "Chalk" },
    ],
    shownIn: "Graphite",
    specs: [
      { label: "Battery", value: "Up to 40 hours with noise cancelling on" },
      { label: "Charging", value: "USB-C. Ten minutes gives five hours" },
      { label: "Drivers", value: "40 mm, custom-tuned" },
      { label: "Connection", value: "Bluetooth 5.4, two devices at once" },
      { label: "Weight", value: "254 g" },
      { label: "In the box", value: "Headphones, knit case, USB-C cable" },
    ],
    badge: "New",
  },
  {
    id: "keys-75",
    slug: "keys-75",
    name: "Keys 75",
    category: "objects",
    price: 18900,
    image: "/products/keyboard.png",
    imageAlt: "Keys 75 mechanical keyboard with stone and cream keycaps and one green escape key",
    tagline: "A 75% mechanical keyboard in a weighted aluminium case.",
    description: [
      "Gasket-mounted for a soft, even feel under every key. Hot-swappable switches, double-shot keycaps in stone and cream, and one green escape key, because every desk deserves one bright thing.",
      "Wired, Bluetooth or the 2.4 GHz dongle that hides in the case.",
    ],
    optionLabel: "Switches",
    options: [
      { id: "linear", label: "Linear" },
      { id: "tactile", label: "Tactile" },
    ],
    specs: [
      { label: "Layout", value: "75%, 84 keys" },
      { label: "Case", value: "Anodised aluminium, 1.6 kg" },
      { label: "Connection", value: "USB-C, Bluetooth, 2.4 GHz" },
      { label: "Battery", value: "4,000 mAh, about a month of work" },
      { label: "Keycaps", value: "Double-shot PBT" },
    ],
  },
  {
    id: "instant-camera",
    slug: "instant-camera",
    name: "Instant Camera",
    category: "objects",
    price: 22900,
    image: "/products/camera.png",
    imageAlt: "An instant film camera in sage green and cream",
    tagline: "Point, shoot, and hold the photograph a minute later.",
    description: [
      "Automatic exposure that gets the light right indoors and out, a close-up mode for the table in front of you, and a flash that knows when to stay off.",
      "It charges over USB-C and takes about a hundred photographs on a charge. Film sold separately.",
    ],
    optionLabel: "Colour",
    options: [
      { id: "sage", label: "Sage" },
      { id: "chalk", label: "Chalk" },
    ],
    shownIn: "Sage",
    specs: [
      { label: "Film", value: "Instant mini film, 54 × 86 mm" },
      { label: "Lens", value: "60 mm, f/12.7" },
      { label: "Exposure", value: "Automatic, with close-up mode" },
      { label: "Power", value: "Rechargeable, about 100 shots per charge" },
      { label: "Weight", value: "306 g" },
    ],
  },
  {
    id: "arc-lamp",
    slug: "arc-lamp",
    name: "Arc Desk Lamp",
    category: "home",
    price: 15900,
    image: "/products/lamp.png",
    imageAlt: "Arc desk lamp with a white domed shade, brass arm and marble base",
    tagline: "Warm, dimmable light on a brushed brass arm.",
    description: [
      "A domed shade throws a soft pool of light where you need it and keeps the glare off your screen. The marble base keeps it steady, and a touch dimmer runs from candle-low to reading-bright.",
    ],
    optionLabel: "Finish",
    options: [
      { id: "chalk-brass", label: "Chalk and brass" },
      { id: "charcoal-brass", label: "Charcoal and brass" },
    ],
    shownIn: "Chalk and brass",
    specs: [
      { label: "Light", value: "LED, 2,700 K, 600 lumens" },
      { label: "Dimming", value: "Touch, stepless" },
      { label: "Height", value: "46 cm" },
      { label: "Base", value: "Carrara marble" },
      { label: "Cable", value: "2 m, braided, with an inline switch" },
    ],
  },
  {
    id: "lounge-chair",
    slug: "lounge-chair",
    name: "Lounge Chair",
    category: "home",
    price: 89900,
    image: "/products/chair.png",
    imageAlt: "A lounge chair with a solid oak frame and oatmeal bouclé cushions",
    tagline: "Solid oak and bouclé, built for the long read.",
    description: [
      "A low, deep seat on a solid oak frame, with cushions wrapped in a wool-blend bouclé that softens with use. The covers come off for cleaning, and the frame is joined, not stapled.",
      "It arrives assembled, carried to the room of your choice.",
    ],
    optionLabel: "Frame",
    options: [
      { id: "oak", label: "Oak" },
      { id: "walnut", label: "Walnut" },
    ],
    shownIn: "Oak",
    specs: [
      { label: "Frame", value: "Solid FSC-certified oak or walnut" },
      { label: "Upholstery", value: "Wool-blend bouclé, removable covers" },
      { label: "Size", value: "W 72 × D 78 × H 74 cm" },
      { label: "Seat height", value: "40 cm" },
      { label: "Delivery", value: "Assembled, to your room, in 5 to 8 days" },
    ],
    delivery: "Free delivery, assembled, in 5 to 8 days",
  },
  {
    id: "pebble-speaker",
    slug: "pebble-speaker",
    name: "Pebble Speaker",
    category: "audio",
    price: 19900,
    image: "/products/speaker.png",
    imageAlt: "Pebble speaker in charcoal knit with a lime carry loop",
    tagline: "Room-filling sound you can carry on one finger.",
    description: [
      "Two drivers and a passive radiator in a knit-wrapped pebble that fills a kitchen and survives the garden. Twenty hours of battery, rain-proof, and two of them pair as a stereo set.",
    ],
    optionLabel: "Colour",
    options: [
      { id: "charcoal", label: "Charcoal" },
      { id: "stone", label: "Stone" },
    ],
    shownIn: "Charcoal",
    specs: [
      { label: "Battery", value: "Up to 20 hours" },
      { label: "Water", value: "IP67, rain-proof and dust-proof" },
      { label: "Pairing", value: "Two speakers as a stereo set" },
      { label: "Weight", value: "540 g" },
      { label: "Charging", value: "USB-C" },
    ],
  },
  {
    id: "court-sneakers",
    slug: "court-sneakers",
    name: "Court Sneakers",
    category: "objects",
    price: 17900,
    image: "/products/sneakers.png",
    imageAlt: "White leather court sneakers with a sage heel tab",
    tagline: "Full-grain leather, and a sole that's stitched, not glued.",
    description: [
      "A clean court shoe in full-grain leather with a sage heel tab, lined in soft calf and set on a stitched rubber cupsole that can be resoled when the first one wears through.",
    ],
    optionLabel: "Size (EU)",
    options: ["38", "39", "40", "41", "42", "43", "44", "45", "46"].map((size) => ({ id: size, label: size })),
    specs: [
      { label: "Upper", value: "Full-grain leather" },
      { label: "Lining", value: "Calf leather" },
      { label: "Sole", value: "Stitched natural rubber cupsole" },
      { label: "Fit", value: "True to size" },
      { label: "Made in", value: "Portugal" },
    ],
  },
  {
    id: "coffee-club",
    slug: "coffee-club",
    name: "Halcyon Coffee Club",
    category: "coffee",
    price: 1800,
    recurring: { interval: "month" },
    image: "/products/coffee.png",
    imageAlt: "A kraft bag of coffee beans beside a cup of black coffee",
    tagline: "A fresh bag from a small roaster, every month.",
    description: [
      "Each month we choose one single-origin coffee from a small roaster, roasted within a week of shipping. A 250 g bag, with a card on who grew it and how to brew it.",
      "Delivery is included. Skip a month or cancel whenever you like.",
    ],
    optionLabel: "Grind",
    options: [
      { id: "whole-bean", label: "Whole bean" },
      { id: "filter", label: "Filter" },
      { id: "espresso", label: "Espresso" },
    ],
    specs: [
      { label: "Bag", value: "250 g, single origin" },
      { label: "Roasted", value: "Within 7 days of shipping" },
      { label: "Ships", value: "The first week of every month" },
      { label: "Billing", value: "Monthly. Skip or cancel any time" },
    ],
  },
];

export const FEATURED_IDS = ["halcyon-one", "lounge-chair", "instant-camera", "arc-lamp", "keys-75", "pebble-speaker"];

export function getProduct(id: string): Product | undefined {
  return PRODUCTS.find((p) => p.id === id);
}

export function getProductBySlug(slug: string): Product | undefined {
  return PRODUCTS.find((p) => p.slug === slug);
}

export function getOption(product: Product, optionId: string): ProductOption | undefined {
  return product.options.find((o) => o.id === optionId);
}

export function categoryName(id: Category): string {
  return CATEGORIES.find((c) => c.id === id)?.name ?? id;
}

/** Orders over this ship free; below it, shipping is a flat rate. */
export const FREE_SHIPPING_THRESHOLD = 15000;
export const FLAT_SHIPPING = 900;

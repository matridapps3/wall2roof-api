import { relations, sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

/**
 * ElectroDash database. All money is stored as integer paise (₹1 = 100) so
 * totals never suffer floating-point rounding.
 */

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
};

/** Where a catalogue row came from. `demo` rows exist only in local development. */
export const sourceEnum = pgEnum('source', ['laravel', 'admin', 'demo']);

export const categories = pgTable(
  'categories',
  {
    id: serial('id').primaryKey(),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    parentId: integer('parent_id'),
    imageUrl: text('image_url'),
    /** Pastel tile colour used by the app's category grid. */
    tint: text('tint'),
    sort: integer('sort').notNull().default(0),
    isActive: boolean('is_active').notNull().default(true),
    source: sourceEnum('source').notNull().default('admin'),
    sourceId: text('source_id'),
    ...timestamps,
  },
  (t) => [uniqueIndex('categories_slug_uq').on(t.slug), index('categories_parent_idx').on(t.parentId)],
);

export const brands = pgTable(
  'brands',
  {
    id: serial('id').primaryKey(),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    logoUrl: text('logo_url'),
    source: sourceEnum('source').notNull().default('admin'),
    ...timestamps,
  },
  (t) => [uniqueIndex('brands_slug_uq').on(t.slug)],
);

export type Spec = { label: string; value: string };

export const products = pgTable(
  'products',
  {
    id: serial('id').primaryKey(),
    sku: text('sku').notNull(),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    brandId: integer('brand_id').references(() => brands.id),
    categoryId: integer('category_id').references(() => categories.id),
    description: text('description'),
    /** Short spec line under the name, e.g. "9W · B22 · 6500K". */
    subtitle: text('subtitle'),
    specs: jsonb('specs').$type<Spec[]>().notNull().default([]),
    images: jsonb('images').$type<string[]>().notNull().default([]),
    mrpPaise: integer('mrp_paise').notNull(),
    pricePaise: integer('price_paise').notNull(),
    /** Products sharing a group key are pack-size / variant siblings ("Pack of 2"). */
    variantGroup: text('variant_group'),
    variantLabel: text('variant_label'),
    stockQty: integer('stock_qty').notNull().default(0),
    /** Max units per order, to stop one customer emptying a store. */
    maxPerOrder: integer('max_per_order').notNull().default(10),
    returnable: boolean('returnable').notNull().default(true),
    returnDays: integer('return_days').notNull().default(7),
    ratingAvg: integer('rating_avg_x10'), // 4.6★ stored as 46
    ratingCount: integer('rating_count').notNull().default(0),
    isActive: boolean('is_active').notNull().default(true),
    isBestseller: boolean('is_bestseller').notNull().default(false),
    source: sourceEnum('source').notNull().default('admin'),
    sourceId: text('source_id'),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('products_sku_uq').on(t.sku),
    uniqueIndex('products_slug_uq').on(t.slug),
    index('products_category_idx').on(t.categoryId),
    index('products_brand_idx').on(t.brandId),
    index('products_group_idx').on(t.variantGroup),
    index('products_search_idx').using(
      'gin',
      sql`to_tsvector('simple', ${t.name} || ' ' || coalesce(${t.subtitle}, ''))`,
    ),
  ],
);

/**
 * Every category a product is listed in (several are allowed). products.category_id is the main
 * one (breadcrumb, similar products) and is always in this set too; the shop also treats a
 * product's category_id as a membership, in case a writer only sets that.
 */
export const productCategories = pgTable(
  'product_categories',
  {
    productId: integer('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    categoryId: integer('category_id')
      .notNull()
      .references(() => categories.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.productId, t.categoryId] }), index('product_categories_category_idx').on(t.categoryId)],
);

export const users = pgTable(
  'users',
  {
    id: serial('id').primaryKey(),
    name: text('name'),
    phone: text('phone'),
    email: text('email'),
    passwordHash: text('password_hash'),
    phoneVerifiedAt: timestamp('phone_verified_at', { withTimezone: true }),
    role: text('role', { enum: ['customer', 'admin'] }).notNull().default('customer'),
    notifyOffers: boolean('notify_offers').notNull().default(false),
    /**
     * When the customer deleted their account in the app: name, phone, email and password are wiped
     * (the row stays because past orders point at it), so their number can sign up again as new.
     */
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [uniqueIndex('users_phone_uq').on(t.phone), uniqueIndex('users_email_uq').on(t.email)],
);

export const otpCodes = pgTable('otp_codes', {
  id: serial('id').primaryKey(),
  phone: text('phone').notNull(),
  codeHash: text('code_hash').notNull(),
  attempts: integer('attempts').notNull().default(0),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const refreshTokens = pgTable('refresh_tokens', {
  id: serial('id').primaryKey(),
  userId: integer('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  /**
   * The token handed out in exchange for this one. This one stays usable until that successor
   * is used, so a refresh whose reply never reached the phone doesn't log the customer out.
   */
  replacedById: integer('replaced_by_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export type AddressFields = {
  label: 'home' | 'work' | 'other';
  otherLabel?: string | null;
  name: string;
  phone: string;
  line1: string;
  line2?: string | null;
  landmark?: string | null;
  city: string;
  state: string;
  pincode: string;
  lat?: number | null;
  lng?: number | null;
};

export const addresses = pgTable('addresses', {
  id: serial('id').primaryKey(),
  userId: integer('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  label: text('label', { enum: ['home', 'work', 'other'] }).notNull().default('home'),
  otherLabel: text('other_label'),
  name: text('name').notNull(),
  phone: text('phone').notNull(),
  line1: text('line1').notNull(),
  line2: text('line2'),
  landmark: text('landmark'),
  city: text('city').notNull(),
  state: text('state').notNull(),
  pincode: text('pincode').notNull(),
  lat: text('lat'),
  lng: text('lng'),
  isDefault: boolean('is_default').notNull().default(false),
  ...timestamps,
});

export const cartItems = pgTable(
  'cart_items',
  {
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    productId: integer('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    qty: integer('qty').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.productId] })],
);

export const wishlist = pgTable(
  'wishlist',
  {
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    productId: integer('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    /** Price when saved, to show "price dropped ₹50". */
    savedPricePaise: integer('saved_price_paise').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.productId] })],
);

export const couponTypeEnum = pgEnum('coupon_type', ['percent', 'flat', 'free_delivery']);

export const coupons = pgTable(
  'coupons',
  {
    id: serial('id').primaryKey(),
    code: text('code').notNull(),
    title: text('title').notNull(),
    description: text('description'),
    type: couponTypeEnum('type').notNull(),
    /** Percent (e.g. 20) for `percent`, paise for `flat`. */
    value: integer('value').notNull().default(0),
    maxDiscountPaise: integer('max_discount_paise'),
    minOrderPaise: integer('min_order_paise').notNull().default(0),
    firstOrderOnly: boolean('first_order_only').notNull().default(false),
    /** Restrict to one category (e.g. lighting), optional. */
    categoryId: integer('category_id').references(() => categories.id),
    validUntil: timestamp('valid_until', { withTimezone: true }),
    isActive: boolean('is_active').notNull().default(true),
    ...timestamps,
  },
  (t) => [uniqueIndex('coupons_code_uq').on(t.code)],
);

/** What tapping a home banner opens. `linkTarget` holds the category or product slug. */
export const bannerLinkEnum = pgEnum('banner_link', ['none', 'category', 'product', 'offers']);

/**
 * Home screen banners (the sliding promo strip). Managed from the Wall2Roof admin, which
 * uploads the image to its own server and writes the row here. Images are 1200×450 (8:3).
 */
export const banners = pgTable(
  'banners',
  {
    id: serial('id').primaryKey(),
    title: text('title').notNull(),
    imageUrl: text('image_url').notNull(),
    linkType: bannerLinkEnum('link_type').notNull().default('none'),
    linkTarget: text('link_target'),
    sort: integer('sort').notNull().default(0),
    isActive: boolean('is_active').notNull().default(true),
    /** Optional campaign window; null = no limit. */
    startsAt: timestamp('starts_at', { withTimezone: true }),
    endsAt: timestamp('ends_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [index('banners_sort_idx').on(t.sort)],
);

/**
 * Themed home blocks (Blinkit's "Checklist for the Season Change"): a title, a row of chosen
 * categories and the picked category's products. Managed from the Wall2Roof admin.
 */
export const homeSections = pgTable(
  'home_sections',
  {
    id: serial('id').primaryKey(),
    title: text('title').notNull(),
    subtitle: text('subtitle'),
    /** Category ids in the order the section shows them. */
    categoryIds: jsonb('category_ids').$type<number[]>().notNull().default([]),
    sort: integer('sort').notNull().default(0),
    isActive: boolean('is_active').notNull().default(true),
    ...timestamps,
  },
  (t) => [index('home_sections_sort_idx').on(t.sort)],
);

export const orderStatusEnum = pgEnum('order_status', [
  'placed',
  'confirmed',
  'packed',
  'out_for_delivery',
  'delivered',
  'cancelled',
]);
export const paymentStatusEnum = pgEnum('payment_status', ['pending', 'paid', 'failed', 'refunded', 'cod_due']);

export const orders = pgTable(
  'orders',
  {
    id: serial('id').primaryKey(),
    number: text('number').notNull(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id),
    status: orderStatusEnum('status').notNull().default('placed'),
    address: jsonb('address').$type<AddressFields>().notNull(),
    deliveryInstructions: jsonb('delivery_instructions').$type<string[]>().notNull().default([]),
    subtotalPaise: integer('subtotal_paise').notNull(),
    mrpTotalPaise: integer('mrp_total_paise').notNull(),
    deliveryFeePaise: integer('delivery_fee_paise').notNull(),
    handlingFeePaise: integer('handling_fee_paise').notNull(),
    codFeePaise: integer('cod_fee_paise').notNull().default(0),
    discountPaise: integer('discount_paise').notNull().default(0),
    /** "Tip your delivery partner": all of it goes to the partner; included in total_paise. */
    tipPaise: integer('tip_paise').notNull().default(0),
    totalPaise: integer('total_paise').notNull(),
    couponCode: text('coupon_code'),
    paymentMethod: text('payment_method', { enum: ['cod', 'online'] }).notNull(),
    paymentStatus: paymentStatusEnum('payment_status').notNull().default('pending'),
    paymentRef: text('payment_ref'),
    /** Sent by the app; a repeated submit returns the same order instead of a duplicate. */
    idempotencyKey: text('idempotency_key').notNull(),
    cancelReason: text('cancel_reason'),
    /** "Add GSTIN": the business's GST number and name, for GST input credit on the invoice. */
    gstin: text('gstin'),
    gstBusinessName: text('gst_business_name'),
    /** A recorded voice instruction for the delivery partner: "<userId>/<name>" under the voice folder. */
    voiceNote: text('voice_note'),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('orders_number_uq').on(t.number),
    uniqueIndex('orders_idem_uq').on(t.userId, t.idempotencyKey),
    index('orders_user_idx').on(t.userId),
  ],
);

export const orderItems = pgTable('order_items', {
  id: serial('id').primaryKey(),
  orderId: integer('order_id')
    .notNull()
    .references(() => orders.id, { onDelete: 'cascade' }),
  productId: integer('product_id').references(() => products.id),
  sku: text('sku').notNull(),
  name: text('name').notNull(),
  image: text('image'),
  qty: integer('qty').notNull(),
  unitPricePaise: integer('unit_price_paise').notNull(),
  unitMrpPaise: integer('unit_mrp_paise').notNull(),
  returnable: boolean('returnable').notNull().default(true),
  returnDays: integer('return_days').notNull().default(7),
});

export const orderEvents = pgTable('order_events', {
  id: serial('id').primaryKey(),
  orderId: integer('order_id')
    .notNull()
    .references(() => orders.id, { onDelete: 'cascade' }),
  status: orderStatusEnum('status').notNull(),
  note: text('note'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const notifications = pgTable('notifications', {
  id: serial('id').primaryKey(),
  userId: integer('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  kind: text('kind', { enum: ['order', 'offer', 'account'] }).notNull(),
  title: text('title').notNull(),
  body: text('body'),
  orderId: integer('order_id'),
  readAt: timestamp('read_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const returnRequests = pgTable('return_requests', {
  id: serial('id').primaryKey(),
  orderId: integer('order_id')
    .notNull()
    .references(() => orders.id),
  userId: integer('user_id')
    .notNull()
    .references(() => users.id),
  items: jsonb('items').$type<{ orderItemId: number; qty: number }[]>().notNull(),
  reason: text('reason').notNull(),
  details: text('details'),
  resolution: text('resolution', { enum: ['replacement', 'refund'] }).notNull(),
  status: text('status', { enum: ['requested', 'approved', 'rejected', 'completed'] })
    .notNull()
    .default('requested'),
  ...timestamps,
});

/**
 * A customer's star rating (and optional words) for a product from one delivered order: each order is
 * rated on its own (rating it again changes that order's rating). A product's stars count each
 * customer once, by their latest rating; products.rating_avg_x10 / rating_count are kept in step.
 */
export const productReviews = pgTable(
  'product_reviews',
  {
    id: serial('id').primaryKey(),
    productId: integer('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** the delivered order it was rated from */
    orderId: integer('order_id').references(() => orders.id, { onDelete: 'set null' }),
    /** 1 to 5 stars */
    rating: integer('rating').notNull(),
    comment: text('comment'),
    ...timestamps,
  },
  (t) => [uniqueIndex('product_reviews_user_product_order_uq').on(t.userId, t.productId, t.orderId), index('product_reviews_product_idx').on(t.productId)],
);

export const supportMessages = pgTable('support_messages', {
  id: serial('id').primaryKey(),
  userId: integer('user_id').references(() => users.id),
  name: text('name').notNull(),
  email: text('email').notNull(),
  phone: text('phone'),
  topic: text('topic').notNull(),
  message: text('message').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Business rules the admin can change without an app release: fees, the
 * delivery promise shown in the app, serviceable PIN codes.
 */
export const settings = pgTable('settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const productsRelations = relations(products, ({ one }) => ({
  brand: one(brands, { fields: [products.brandId], references: [brands.id] }),
  category: one(categories, { fields: [products.categoryId], references: [categories.id] }),
}));

export const ordersRelations = relations(orders, ({ many }) => ({
  items: many(orderItems),
  events: many(orderEvents),
}));

export const orderItemsRelations = relations(orderItems, ({ one }) => ({
  order: one(orders, { fields: [orderItems.orderId], references: [orders.id] }),
}));

export const orderEventsRelations = relations(orderEvents, ({ one }) => ({
  order: one(orders, { fields: [orderEvents.orderId], references: [orders.id] }),
}));

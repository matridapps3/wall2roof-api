/**
 * Server-side cart pricing. The app shows these numbers; it never computes a
 * payable amount itself. All values are integer paise.
 */

export type PricingProduct = {
  id: number;
  name: string;
  pricePaise: number;
  mrpPaise: number;
  stockQty: number;
  maxPerOrder: number;
  isActive: boolean;
  categoryId: number | null;
  /** Every category the product is listed in (main and extra), when known. */
  categoryIds?: number[];
};

export type PricingCoupon = {
  code: string;
  title: string;
  type: 'percent' | 'flat' | 'free_delivery';
  value: number;
  maxDiscountPaise: number | null;
  minOrderPaise: number;
  firstOrderOnly: boolean;
  categoryId: number | null;
  validUntil: Date | null;
  isActive: boolean;
};

export type FeeSettings = {
  deliveryFeePaise: number;
  freeDeliveryMinPaise: number;
  handlingFeePaise: number;
  codFeePaise: number;
};

export type LineIssue =
  | { code: 'unavailable' }
  | { code: 'insufficient_stock'; available: number }
  | { code: 'over_limit'; max: number };

export type QuoteLine = {
  productId: number;
  qty: number;
  unitPricePaise: number;
  unitMrpPaise: number;
  lineTotalPaise: number;
  issue: LineIssue | null;
};

export type CouponResult =
  | { code: string; applied: true; title: string; discountPaise: number; freeDelivery: boolean }
  | { code: string; applied: false; reason: string };

export type Quote = {
  lines: QuoteLine[];
  itemCount: number;
  mrpTotalPaise: number;
  subtotalPaise: number;
  deliveryFeePaise: number;
  /** Fee before waivers, so the app can show "₹25 FREE". */
  deliveryFeeBeforeWaiverPaise: number;
  handlingFeePaise: number;
  codFeePaise: number;
  discountPaise: number;
  /** The delivery partner's tip, included in the total. */
  tipPaise: number;
  totalPaise: number;
  /** MRP savings + coupon discount + waived delivery. */
  savingsPaise: number;
  coupon: CouponResult | null;
  /** Lines with problems; checkout is blocked while any exist. */
  blocking: boolean;
};

/** The most a customer can tip (₹500). */
export const MAX_TIP_PAISE = 50_000;

export function rupees(paise: number): string {
  return `₹${(paise / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
}

function lineIssue(p: PricingProduct, qty: number): LineIssue | null {
  if (!p.isActive || p.stockQty <= 0) return { code: 'unavailable' };
  if (qty > p.stockQty) return { code: 'insufficient_stock', available: p.stockQty };
  if (qty > p.maxPerOrder) return { code: 'over_limit', max: p.maxPerOrder };
  return null;
}

export function evaluateCoupon(
  coupon: PricingCoupon,
  lines: { product: PricingProduct; qty: number }[],
  ctx: { isFirstOrder: boolean; now: Date },
): CouponResult {
  const code = coupon.code;
  if (!coupon.isActive) return { code, applied: false, reason: 'This coupon is no longer active.' };
  if (coupon.validUntil && coupon.validUntil.getTime() < ctx.now.getTime()) {
    return { code, applied: false, reason: 'This coupon has expired.' };
  }
  if (coupon.firstOrderOnly && !ctx.isFirstOrder) {
    return { code, applied: false, reason: 'This coupon is only for your first order.' };
  }
  const eligible = lines
    // a category coupon covers every product listed in that category, not only its main one
    .filter((l) => coupon.categoryId == null || l.product.categoryId === coupon.categoryId || !!l.product.categoryIds?.includes(coupon.categoryId))
    .reduce((s, l) => s + l.product.pricePaise * l.qty, 0);
  if (eligible === 0) {
    return { code, applied: false, reason: 'No items in your cart qualify for this coupon.' };
  }
  if (eligible < coupon.minOrderPaise) {
    return {
      code,
      applied: false,
      reason: `Add ${rupees(coupon.minOrderPaise - eligible)} more to use this coupon.`,
    };
  }
  let discount = 0;
  if (coupon.type === 'percent') {
    discount = Math.floor((eligible * coupon.value) / 100);
    if (coupon.maxDiscountPaise != null) discount = Math.min(discount, coupon.maxDiscountPaise);
  } else if (coupon.type === 'flat') {
    discount = Math.min(coupon.value, eligible);
  }
  return {
    code,
    applied: true,
    title: coupon.title,
    discountPaise: discount,
    freeDelivery: coupon.type === 'free_delivery',
  };
}

export function quote(input: {
  lines: { product: PricingProduct; qty: number }[];
  fees: FeeSettings;
  coupon?: PricingCoupon | null;
  /** Code the customer typed that matched no coupon. */
  unknownCouponCode?: string | null;
  paymentMethod?: 'cod' | 'online' | null;
  /** "Tip your delivery partner" (paise); ignored for an empty cart. */
  tipPaise?: number;
  isFirstOrder: boolean;
  now?: Date;
}): Quote {
  const now = input.now ?? new Date();
  const lines: QuoteLine[] = input.lines.map(({ product, qty }) => {
    const issue = lineIssue(product, qty);
    return {
      productId: product.id,
      qty,
      unitPricePaise: product.pricePaise,
      unitMrpPaise: Math.max(product.mrpPaise, product.pricePaise),
      lineTotalPaise: product.pricePaise * qty,
      issue,
    };
  });

  // Unavailable lines don't count towards totals; other issues still block checkout.
  const counted = input.lines.filter((_, i) => lines[i].issue?.code !== 'unavailable');
  const subtotal = counted.reduce((s, l) => s + l.product.pricePaise * l.qty, 0);
  const mrpTotal = counted.reduce((s, l) => s + Math.max(l.product.mrpPaise, l.product.pricePaise) * l.qty, 0);
  const itemCount = counted.reduce((n, l) => n + l.qty, 0);

  let coupon: CouponResult | null = null;
  if (input.coupon) coupon = evaluateCoupon(input.coupon, counted, { isFirstOrder: input.isFirstOrder, now });
  else if (input.unknownCouponCode) {
    coupon = { code: input.unknownCouponCode, applied: false, reason: 'This coupon code is not valid.' };
  }

  const empty = itemCount === 0;
  const deliveryBefore = empty ? 0 : input.fees.deliveryFeePaise;
  const waived =
    subtotal >= input.fees.freeDeliveryMinPaise || (coupon?.applied === true && coupon.freeDelivery);
  const deliveryFee = waived ? 0 : deliveryBefore;
  const handlingFee = empty ? 0 : input.fees.handlingFeePaise;
  const codFee = !empty && input.paymentMethod === 'cod' ? input.fees.codFeePaise : 0;
  const discount = coupon?.applied ? Math.min(coupon.discountPaise, subtotal) : 0;
  const tip = empty ? 0 : Math.max(0, Math.round(input.tipPaise ?? 0));
  const total = subtotal - discount + deliveryFee + handlingFee + codFee + tip;

  return {
    lines,
    itemCount,
    mrpTotalPaise: mrpTotal,
    subtotalPaise: subtotal,
    deliveryFeePaise: deliveryFee,
    deliveryFeeBeforeWaiverPaise: deliveryBefore,
    handlingFeePaise: handlingFee,
    codFeePaise: codFee,
    discountPaise: discount,
    tipPaise: tip,
    totalPaise: total,
    savingsPaise: mrpTotal - subtotal + discount + (deliveryBefore - deliveryFee),
    coupon,
    blocking: lines.some((l) => l.issue !== null),
  };
}

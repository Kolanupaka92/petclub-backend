'use strict';
/**
 * Zod request validation middleware.
 *
 * Usage:
 *   const { validate, schemas } = require('./middleware/validate');
 *   app.post('/api/bookings', auth, validate(schemas.createBooking), handler);
 *
 * validate() calls next(err) with a 400-status ZodError so the global error
 * handler formats a consistent { error, details } response — no try/catch needed
 * in individual route handlers.
 */

const { z } = require('zod');

// ── Reusable primitives ────────────────────────────────────────────────────────
const uuid      = z.string().uuid();
const phone     = z.string().regex(/^\+[1-9]\d{6,14}$/, 'Phone must be E.164 format e.g. +919876543210');
const email     = z.string().email('Invalid email address');
const isoDate   = z.string().datetime({ offset: true, message: 'Must be ISO-8601 datetime with timezone' });
const shortText = (label) => z.string().min(1).max(200, `${label} must be under 200 characters`);
const longText  = (label) => z.string().max(2000, `${label} must be under 2000 characters`).optional();
const positiveNum = z.number().positive();

// ── Auth schemas ───────────────────────────────────────────────────────────────
const firebaseVerify = z.object({
  idToken: z.string().min(10, 'Firebase ID token required'),
});

const sendEmailOtp = z.object({
  email: email,
});

const verifyEmailOtp = z.object({
  email:  email,
  otp:    z.string().length(6, 'OTP must be exactly 6 digits').regex(/^\d{6}$/),
});

const sendPhoneOtp = z.object({
  phone: phone,
});

const verifyPhoneOtp = z.object({
  phone: phone,
  otp:   z.string().length(6, 'OTP must be exactly 6 digits').regex(/^\d{6}$/),
});

// ── User schemas ───────────────────────────────────────────────────────────────
const setRole = z.object({
  role:    z.enum(['customer', 'professional'], { errorMap: () => ({ message: 'Role must be customer or professional' }) }),
  subRole: z.string().max(50).optional(),
  name:    shortText('Name').optional(),
  email:   email.optional(),
  city:    shortText('City').optional(),
  address: longText('Address'),
  addressLat:        z.number().min(-90).max(90).optional().nullable(),
  addressLng:        z.number().min(-180).max(180).optional().nullable(),
  addressPostalCode: z.string().max(10).optional().nullable(),
  addressCity:       z.string().max(100).optional().nullable(),
  addressState:      z.string().max(100).optional().nullable(),
  referral_input:    z.string().max(50).optional().nullable(),
  pet: z.object({
    name:    shortText('Pet name'),
    species: z.enum(['dog', 'cat', 'other']),
    breed:   z.string().max(100).optional(),
  }).optional(),
});

const updateMe = z.object({
  name:      shortText('Name').optional(),
  email:     email.optional(),
  city:      shortText('City').optional(),
  area:      shortText('Area').optional(),
  address:   longText('Address'),
  pincode:   z.string().max(10).optional(),
  photo_url: z.string().url('Invalid photo URL').optional().nullable(),
});

const fcmToken = z.object({
  token: z.string().min(10, 'FCM token required').max(500),
});

// ── Pet schemas ────────────────────────────────────────────────────────────────
const createPet = z.object({
  name:         shortText('Pet name'),
  species:      z.enum(['dog', 'cat', 'other'], { errorMap: () => ({ message: 'Species must be dog, cat, or other' }) }),
  breed:        z.string().max(100).optional(),
  age:          z.number().int().min(0).max(30).optional().nullable(),
  gender:       z.enum(['male', 'female']).optional().nullable(),
  dob:          z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'DOB must be YYYY-MM-DD').optional().nullable(),
  weight:       z.number().min(0).max(200).optional().nullable(),
  health_notes: z.string().max(2000).optional().nullable(),
  photo_url:    z.string().url('Invalid photo URL').optional().nullable(),
});

const updatePet = createPet.partial();

// ── Booking schemas ────────────────────────────────────────────────────────────
const VALID_SERVICE_TYPES = ['Groomer', 'Trainer', 'Vet', 'Walker', 'Boarding'];

const createBooking = z.object({
  terms_accepted: z.literal(true, { errorMap: () => ({ message: 'You must accept the Terms of Service and Privacy Policy' }) }),
  service_type:   z.enum(/** @type {[string, ...string[]]} */ (VALID_SERVICE_TYPES), { errorMap: () => ({ message: `service_type must be one of: ${VALID_SERVICE_TYPES.join(', ')}` }) }),
  service_name:   shortText('Service name').optional(),
  city:           shortText('City').optional(),
  pet_id:         uuid.optional().nullable(),
  scheduled_at:   isoDate.optional().nullable(),
  address:        z.string().max(500).optional().nullable(),
  notes:          z.string().max(2000).optional().nullable(),
  lat:            z.number().min(-90).max(90).optional().nullable(),
  lng:            z.number().min(-180).max(180).optional().nullable(),
  pet_size:       z.enum(['Small', 'Medium', 'Large', 'Cat']).optional().nullable(),
  addons:         z.array(z.string().max(50)).max(10).optional(),
  coupon_code:    z.string().max(20).optional().nullable(),
});

const updateBookingStatus = z.object({
  status: z.enum(['cancelled', 'completed', 'in_progress', 'upcoming', 'no_show'],
    { errorMap: () => ({ message: 'Invalid status' }) }),
  cancel_reason: z.string().max(500).optional(),
  by_no_show:    z.boolean().optional(),
});

const respondBooking = z.object({
  accept: z.boolean({ required_error: 'accept (boolean) is required' }),
});

const sendMessage = z.object({
  message: z.string().min(1).max(2000, 'Message must be under 2000 characters'),
});

const locationUpdate = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});

const rateBooking = z.object({
  rating:  z.number().int().min(1).max(5),
  comment: z.string().max(1000).optional(),
});

const updateRefundStatus = z.object({
  refund_status: z.enum(['pending', 'processing', 'refunded', 'failed'],
    { errorMap: () => ({ message: 'Invalid refund_status' }) }),
  refund_reference: z.string().max(100).optional(),
});

const assignBooking = z.object({
  professional_id: uuid,
});

// ── Professional schemas ───────────────────────────────────────────────────────
const applyProfessional = z.object({
  sub_role:     z.enum(['Groomer', 'Trainer', 'Vet', 'Walker', 'Boarding'],
    { errorMap: () => ({ message: 'sub_role must be one of: Groomer, Trainer, Vet, Walker, Boarding' }) }),
  city:         shortText('City'),
  area:         shortText('Area').optional(),
  address:      z.string().max(500).optional(),
  bio:          z.string().max(2000).optional(),
  experience:   z.string().max(500).optional(),
  services:     z.array(z.string().max(100)).max(20).optional(),
  service_areas: z.string().max(500).optional(),
  langs:        z.string().max(200).optional(),
  price_basic:  z.string().max(50).optional(),
  price_full:   z.string().max(50).optional(),
  price_custom: z.string().max(50).optional(),
});

const updateProfessional = applyProfessional.partial();

const setAvailability = z.object({
  is_available: z.boolean({ required_error: 'is_available (boolean) is required' }),
});

const payoutRequest = z.object({
  upi_id:         z.string().max(100).optional(),
  bank_name:      z.string().max(100).optional(),
  account_number: z.string().max(30).optional(),
  account_holder: z.string().max(100).optional(),
  ifsc_code:      z.string().max(20).optional(),
  payment_type:   z.enum(['upi', 'bank']).optional(),
}).refine(d => d.upi_id || d.account_number, { message: 'Either upi_id or bank account details are required' });

// ── Loyalty schemas ────────────────────────────────────────────────────────────
const validateCoupon = z.object({
  code: z.string().min(1).max(20, 'Coupon code must be under 20 characters').toUpperCase(),
});

const awardLoyalty = z.object({
  user_id: uuid,
  points:  z.number().int().min(1).max(100000),
  reason:  z.string().max(200),
});

// ── Admin schemas ──────────────────────────────────────────────────────────────
const makeAdmin = z.object({
  phone:       phone,
  countryCode: z.string().max(4).optional().default('91'),
  secret:      z.string().min(1, 'secret required'),
});

const setUserRole = z.object({
  role: z.enum(['customer', 'professional', 'admin', 'pending_role'],
    { errorMap: () => ({ message: 'Invalid role' }) }),
});

const verifyProfessional = z.object({
  status: z.enum(['verified', 'rejected', 'pending'],
    { errorMap: () => ({ message: 'status must be verified, rejected, or pending' }) }),
  notes: z.string().max(500).optional(),
});

const adminEditUser = z.object({
  name:         z.string().max(200).optional(),
  email:        email.optional(),
  phone:        phone.optional(),
  is_active:    z.boolean().optional(),
  role:         z.enum(['customer', 'professional', 'admin', 'pending_role']).optional(),
  city:         z.string().max(100).optional(),
  area:         z.string().max(100).optional(),
});

const suspendUser = z.object({
  reason: z.string().max(500).optional(),
});

// ── Payment schemas ────────────────────────────────────────────────────────────
const createPaymentOrder = z.object({
  booking_id: uuid,
  currency:   z.enum(['INR', 'USD']).optional().default('INR'),
});

const verifyPayment = z.object({
  razorpay_order_id:   z.string().min(1),
  razorpay_payment_id: z.string().min(1),
  razorpay_signature:  z.string().min(1),
  booking_id:          uuid,
});

// ── Contact schema ─────────────────────────────────────────────────────────────
const sendLink = z.object({
  email: email.optional(),
  phone: phone.optional(),
}).refine(d => d.email || d.phone, { message: 'Either email or phone is required' });

// ── Middleware factory ─────────────────────────────────────────────────────────
/**
 * Returns Express middleware that validates req.body against the given Zod schema.
 * On failure passes a structured error to next() — caught by the global error handler.
 */
function validate(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      const details = result.error.issues.map(i => ({
        field:   i.path.join('.'),
        message: i.message,
      }));
      return res.status(400).json({
        error:   'Validation failed',
        details,
      });
    }
    // Replace req.body with the parsed (coerced + stripped) value
    req.body = result.data;
    next();
  };
}

module.exports = {
  validate,
  schemas: {
    // Auth
    firebaseVerify,
    sendEmailOtp,
    verifyEmailOtp,
    sendPhoneOtp,
    verifyPhoneOtp,
    // Users
    setRole,
    updateMe,
    fcmToken,
    // Pets
    createPet,
    updatePet,
    // Bookings
    createBooking,
    updateBookingStatus,
    respondBooking,
    sendMessage,
    locationUpdate,
    rateBooking,
    updateRefundStatus,
    assignBooking,
    // Professionals
    applyProfessional,
    updateProfessional,
    setAvailability,
    payoutRequest,
    // Loyalty
    validateCoupon,
    awardLoyalty,
    // Admin
    makeAdmin,
    setUserRole,
    verifyProfessional,
    adminEditUser,
    suspendUser,
    // Payments
    createPaymentOrder,
    verifyPayment,
    // Contact
    sendLink,
  },
};

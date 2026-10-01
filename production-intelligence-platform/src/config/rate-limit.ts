import {
  rateLimit
} from "express-rate-limit";

interface RateLimitOptions {
  windowMs: number;
  limit: number;
}

export const createRateLimiter = (
  options: RateLimitOptions
) => {

  return rateLimit({
    windowMs:
      options.windowMs,

    limit:
      options.limit,

    standardHeaders:
      "draft-8",

    legacyHeaders:
      false,

    message: {
      success: false,
      error: {
        code:
          "RATE_LIMIT_EXCEEDED",
        message:
          "Too many requests"
      }
    }
  });
};

export const apiRateLimiter =
  createRateLimiter({
    windowMs:
      15 * 60 * 1000,

    limit: 100
  });
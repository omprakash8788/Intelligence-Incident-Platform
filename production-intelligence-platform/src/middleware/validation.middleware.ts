import { Request, Response, NextFunction } from "express";
import { ValidationError } from "../errors/ValidationError.js";

type Validator = (req: Request) => void;

export const validate = (validator: Validator) => {
  return (
    req: Request,
    _res: Response,
    next: NextFunction
  ) => {
    try {
      validator(req);
      next();
    } catch (error) {
      if (error instanceof ValidationError) {
        next(error);
        return;
      }

      next(error);
    }
  };
};


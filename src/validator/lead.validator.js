import { z } from 'zod';

// Validation schema for creating a lead
export const createLeadSchema = z.object({
  name: z.string().min(1, 'Name is required').max(100, 'Name must be less than 100 characters'),
  email: z.string().email('Invalid email format'),
  phone: z.string().optional().refine((val) => !val || /^[\+]?[1-9][\d]{0,15}$/.test(val), {
    message: 'Invalid phone number format'
  }),
  company: z.string().max(100, 'Company name must be less than 100 characters').optional(),
  jobTitle: z.string().max(100, 'Job title must be less than 100 characters').optional(),
  companyWebsite: z.string().url('Invalid website URL').optional().or(z.literal(''))
});

// Middleware to validate lead data
export const validateLeadData = (req, res, next) => {
  try {
    const validatedData = createLeadSchema.parse(req.body);
    req.body = validatedData;
    next();
  } catch (error) {
    if (error instanceof z.ZodError) {
      const errorMessage = error.errors.map(err => err.message).join(', ');
      return res.status(400).json({
        success: false,
        statusCode: 400,
        message: 'Validation failed',
        error: errorMessage
      });
    }
    next(error);
  }
};

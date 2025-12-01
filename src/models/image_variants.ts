import mongoose, { Document, Schema, Model } from 'mongoose';

export enum ImageStatus {
  Queued = 'queued',
  Processing = 'processing',
  Ready = 'ready',
  Failed = 'failed',
}

export interface IImageVariant extends Document {
  imageId: string;
  width: number;
  height: number;
  s3Key: string;
  s3Bucket: string;
  status: ImageStatus;
  originalS3Key: string;
  fileSize: number;
  createdAt: Date;
  failedReason?: string | null;
  failedAt?: Date | null;
  requeueCount: number; // how many times the job has been requeued
}

const ImageVariantSchema = new Schema<IImageVariant>(
  {
    imageId: {
      type: String,
      required: true,
      index: true,
      trim: true,
    },
    width: {
      type: Number,
      required: true,
      min: 1,
    },
    height: {
      type: Number,
      required: true,
      min: 1,
    },
    s3Key: {
      type: String,
      required: true,
      trim: true,
    },
    s3Bucket: {
      type: String,
      required: true,
      trim: true,
    },
    status: {
      type: String,
      enum: Object.values(ImageStatus),
      default: ImageStatus.Queued,
      required: true,
    },
    originalS3Key: {
      type: String,
      required: true,
      trim: true,
    },
    fileSize: {
      type: Number,
      required: true,
      min: 0,
    },
    failedReason: {
      type: String,
      trim: true,
      default: null,
    },
    failedAt: {
      type: Date,
      default: null,
    },
    requeueCount: {
      type: Number,
      default: 0,
      min: 0,
    },
  },
  {
    collection: 'image_variants',
    timestamps: { createdAt: true, updatedAt: false },
  },
);

// Unique combination of imageId + width + height
ImageVariantSchema.index({ imageId: 1, width: 1, height: 1 }, { unique: true });

// Index by status for faster queries on queued/processing/failed
ImageVariantSchema.index({ status: 1 });

export const ImageVariants: Model<IImageVariant> =
  mongoose.models.ImageVariants ||
  mongoose.model<IImageVariant>('ImageVariants', ImageVariantSchema);

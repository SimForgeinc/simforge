import { z } from "zod";

import { SensorSchema } from "@simforge-oss/scenario/contracts";

export const ActorSensorRigSchema = z
  .object({
    actor_name: z.string().min(1),
    sensor_rig: z
      .object({
        id: z.string().min(1),
        name: z.string().min(1),
        sensors: z.array(SensorSchema).default([]),
      })
      .passthrough(),
    sensors: z.array(SensorSchema).default([]),
    gt_channels: z.array(z.string()).default([]),
  })
  .passthrough();

export type ActorSensorRig = z.infer<typeof ActorSensorRigSchema>;

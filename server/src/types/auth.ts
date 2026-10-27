import type { Request } from "express";
import type { Participant, Room } from "@prisma/client";

export interface AuthenticatedRequest extends Request {
  participant?: Participant;
  room?: Room;
}

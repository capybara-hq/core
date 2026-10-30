import { createZodDto } from "../infra/validation/create-zod-dto.js";

export class CreateAgentDto extends createZodDto(schema) {}
export class ListAgentsQuery extends createZodDto(query) {}

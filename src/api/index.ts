import dotenv from "dotenv";
import { createServer } from "./config/express";
import { env } from "../config";
import { logger } from "../logger";
dotenv.config();

const PORT = env.PORT;
const app = createServer();
app.listen(PORT, () => {
  logger.info(`Server running on port ${PORT}`);
});

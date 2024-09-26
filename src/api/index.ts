import figlet from "figlet";
import { env } from "../config";
import { logger } from "../logger";
import { createServer } from "./entry-points/server";
import { setRoutes } from "./entry-points/routes";

const startServer = () => {
  const PORT = env.PORT;
  const app = createServer();
  setRoutes(app);
  console.log(figlet.textSync("Blazar Payments", { font: "Doom" }));
  app.listen(PORT, () => {
    logger.info(`Server running on port ${PORT}`);
  });
};

startServer();

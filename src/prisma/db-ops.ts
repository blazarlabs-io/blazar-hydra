import { prisma } from '../config';
import { logger } from '../logger';
import { DBStatus } from '../shared/prisma-schemas';

export namespace DBOps {
  export const newHead = async () => {
    const newProcess = await prisma.process
      .create({
        data: {
          status: DBStatus.INITIALIZING,
        },
      })
      .catch((error) => {
        logger.error('DB Error while opening head: ' + error);
        throw error;
      });
    return newProcess.id;
  };

  export const updateHeadStatus = async (id: string, status: DBStatus) => {
    await prisma.process
      .upsert({
        where: { id },
        update: { status },
        create: { id, status },
      })
      .catch((error) => {
        logger.error(`DB Error while updating status to ${status}: ${error}`);
        throw error;
      });
  };

  export const cleanDB = async () => {
    await prisma.process.deleteMany().catch((error) => {
      logger.error('DB Error while cleaning up: ' + error);
      throw error;
    });
  };
}

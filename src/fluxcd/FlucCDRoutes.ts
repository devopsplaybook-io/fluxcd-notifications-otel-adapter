import { FastifyInstance } from "fastify";

export class FlucCDRoutes {
  //

  public async getRoutes(fastify: FastifyInstance): Promise<void> {
    //
    fastify.get("/status/initialization", async (req, res) => {
      console.log(req);
      res.status(200).send({});
    });
  }
}

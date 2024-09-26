import e from "express";
import { API_ROUTES } from "../schemas/routes";

const setRoutes = (expressApp: e.Application) => {
  expressApp.post(API_ROUTES.DEPOSIT, (req, res) => {
    res.send("Deposit ada route");
  });

  expressApp.post(API_ROUTES.WITHDRAW, (req, res) => {
    res.send("Withdraw funds route");
  });

  expressApp.post(API_ROUTES.PAY, (req, res) => {
    res.send("Pay merchant route");
  });

  expressApp.get(API_ROUTES.QUERY_FUNDS, (req, res) => {
    res.send("Query funds route");
  });

  expressApp.post(API_ROUTES.OPEN_HEAD, (req, res) => {
    res.send("Open hydra head route");
  });

  expressApp.post(API_ROUTES.CLOSE_HEAD, (req, res) => {
    res.send("Close hydra head route");
  });
};

export { setRoutes };

import express, { type Request, type Response, type Router } from "express";
import { callbackHandler, loginHandler, logoutHandler, requireAdmin } from "./auth.js";
import * as dashboard from "./pages/dashboard.js";
import * as digests from "./pages/digests.js";
import * as recipients from "./pages/recipients.js";
import * as settings from "./pages/settings.js";
import * as targets from "./pages/targets.js";
import * as users from "./pages/users.js";
import { layout } from "./render.js";

export function adminRouter(): Router {
  const r = express.Router();
  r.use(express.urlencoded({ extended: false }));

  // Unguarded auth endpoints
  r.get("/auth/login", loginHandler);
  r.get("/auth/callback", callbackHandler);
  r.get("/auth/logout", logoutHandler);

  // Everything below requires an admin session
  r.use(requireAdmin);

  const page =
    (title: string, mod: { render: (req: Request) => Promise<string> }) =>
    async (req: Request, res: Response) => {
      res.type("html").send(
        layout(title, await mod.render(req), {
          flash: typeof req.query.msg === "string" ? req.query.msg : undefined,
        }),
      );
    };

  const submit =
    (mod: {
      submit: (req: Request) => Promise<{ redirect: string; flash?: string } | { error: string }>;
    }) =>
    async (req: Request, res: Response) => {
      const out = await mod.submit(req);
      if ("error" in out) {
        res
          .status(400)
          .type("html")
          .send(layout("Error", `<p class="error">${out.error}</p>`));
        return;
      }
      res.redirect(out.redirect + (out.flash ? `?msg=${encodeURIComponent(out.flash)}` : ""));
    };

  const editPage =
    (fn: (req: Request) => Promise<{ title: string; body: string }>) =>
    async (req: Request, res: Response) => {
      const { title, body } = await fn(req);
      res.type("html").send(
        layout(title, body, {
          activeNav: "Digests",
          flash: typeof req.query.msg === "string" ? req.query.msg : undefined,
        }),
      );
    };

  const submitFn =
    (fn: (req: Request) => Promise<{ redirect: string; flash?: string } | { error: string }>) =>
    async (req: Request, res: Response) => {
      const out = await fn(req);
      if ("error" in out) {
        res
          .status(400)
          .type("html")
          .send(layout("Error", `<p class="error">${out.error}</p>`, { activeNav: "Digests" }));
        return;
      }
      res.redirect(out.redirect + (out.flash ? `?msg=${encodeURIComponent(out.flash)}` : ""));
    };

  r.get("/", page("Dashboard", dashboard));
  r.get("/users", page("Users", users));
  r.post("/users", submit(users));
  r.get("/recipients", page("Recipients", recipients));
  r.post("/recipients", submit(recipients));
  r.get("/settings", page("Settings", settings));
  r.post("/settings", submit(settings));
  r.get("/digests", page("Digests", digests));
  r.get("/digests/prompts/:id", editPage(digests.renderPromptEdit));
  r.post("/digests/prompts", submitFn(digests.submitPrompt));
  r.post("/digests/prompts/:id/preview", editPage(digests.previewPrompt));
  r.post("/digests/prompts/:id/test", submitFn(digests.testPrompt));
  r.get("/digests/schedules/:id", editPage(digests.renderScheduleEdit));
  r.post("/digests/schedules", submitFn(digests.submitSchedule));
  r.get("/targets", page("Targets", targets));
  r.get("/targets/:id", async (req: Request, res: Response) => {
    const { title, body } = await targets.renderEdit(req);
    res.type("html").send(layout(title, body, { activeNav: "Targets" }));
  });
  r.post("/targets", submit(targets));

  return r;
}

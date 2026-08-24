import { LOCAL_SESSION } from "./session";

export const authClient = {
  async getSession() {
    return { data: { user: LOCAL_SESSION } };
  },
};

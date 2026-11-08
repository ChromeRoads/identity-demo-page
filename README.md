# identity-demo-page

The customer-shaped demonstration page for the Chrome Roads Relying Party service: a static page that runs a
WebAuthn registration or authentication against the RP, cross-origin, holding nothing but a one-time ceremony
token handed to it in the URL fragment by the customer's own backend.

**Source of truth:** `rp/demo/page/` in the Chrome Roads `Digital-Identity-Full-Stack` repository (private). This
public repository only publishes those two files through GitHub Pages at
`https://chromeroads.github.io/identity-demo-page/`. Do not edit here; change the source and copy.

There are no secrets, no analytics and no build step in this page. It does nothing until a backend hands it a
ceremony token, and the RP only accepts it from the origins a tenant has allow-listed.

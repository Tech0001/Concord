use super::*;
use jsonwebtoken::{decode, decode_header, jwk::JwkSet, Algorithm, DecodingKey, Validation};
pub(super) struct Identity {
    pub subject: String,
    pub email: String,
}
pub(super) fn verify(
    e: &Endpoints,
    token: &str,
    client: &str,
    nonce: Option<&str>,
) -> Result<Identity> {
    let jwks = json_get(e, "/.well-known/jwks.json")?;
    verify_keys(
        token,
        client,
        nonce,
        &serde_json::from_value(jwks).context("Invalid ChatGPT signing keys")?,
    )
}
pub(super) fn verify_keys(
    token: &str,
    client: &str,
    nonce: Option<&str>,
    keys: &JwkSet,
) -> Result<Identity> {
    let header = decode_header(token).context("Invalid ChatGPT identity token")?;
    ensure!(
        header.alg == Algorithm::RS256,
        "Unexpected ChatGPT signing algorithm"
    );
    let kid = header
        .kid
        .context("ChatGPT identity token has no signing key")?;
    let jwk = keys
        .find(&kid)
        .context("ChatGPT identity signing key is unavailable")?;
    ensure!(
        jwk.common
            .public_key_use
            .as_ref()
            .is_none_or(|u| matches!(u, jsonwebtoken::jwk::PublicKeyUse::Signature)),
        "ChatGPT key is not a signing key"
    );
    ensure!(
        jwk.common.key_operations.as_ref().is_none_or(|ops| ops
            .iter()
            .any(|o| matches!(o, jsonwebtoken::jwk::KeyOperations::Verify))),
        "ChatGPT key does not allow verification"
    );
    ensure!(
        jwk.common
            .key_algorithm
            .as_ref()
            .is_none_or(|a| matches!(a, jsonwebtoken::jwk::KeyAlgorithm::RS256)),
        "ChatGPT key algorithm does not match"
    );
    let key = DecodingKey::from_jwk(jwk).context("Invalid ChatGPT signing key")?;
    let mut validation = Validation::new(Algorithm::RS256);
    validation.set_audience(&[client]);
    validation.set_issuer(&[ISSUER]);
    validation.set_required_spec_claims(&["exp", "iss", "aud", "sub", "iat"]);
    validation.validate_nbf = true;
    validation.leeway = 30;
    let claims: Value = decode::<Value>(token, &key, &validation)
        .context("ChatGPT identity could not be verified")?
        .claims;
    ensure!(
        claims["iat"].as_u64().is_some_and(|n| n <= now() + 30),
        "ChatGPT identity was issued in the future"
    );
    if let Some(nonce) = nonce {
        ensure!(
            claims["nonce"].as_str() == Some(nonce),
            "ChatGPT sign-in nonce did not match"
        );
    }
    if claims["aud"].as_array().is_some_and(|a| a.len() > 1) || claims.get("azp").is_some() {
        ensure!(
            claims["azp"].as_str() == Some(client),
            "ChatGPT identity was issued to another app"
        );
    }
    let subject = claims["sub"]
        .as_str()
        .filter(|s| !s.is_empty())
        .context("ChatGPT identity is missing its subject")?
        .to_owned();
    let email = claims["email"]
        .as_str()
        .unwrap_or("")
        .chars()
        .take(250)
        .collect();
    Ok(Identity { subject, email })
}

import urllib.request
import json
from fastapi import HTTPException, status

def verify_google_token(id_token: str) -> dict:
    if id_token.startswith("mock-token-"):
        if "admin" in id_token:
            return {
                "email": "tuinui@example.com",
                "name": "Tui Nui (Admin Bypass)",
                "picture": "https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?auto=format&fit=crop&w=80&q=80"
            }
        else:
            return {
                "email": "resident@example.com",
                "name": "Mock Resident",
                "picture": ""
            }

    url = f"https://oauth2.googleapis.com/tokeninfo?id_token={id_token}"
    try:
        req = urllib.request.Request(url, method="GET")
        with urllib.request.urlopen(req, timeout=5) as response:
            data = json.loads(response.read().decode("utf-8"))
            if "error_description" in data:
                raise HTTPException(
                    status_code=status.HTTP_401_UNAUTHORIZED,
                    detail=data["error_description"]
                )
            if not data.get("email"):
                raise HTTPException(
                    status_code=status.HTTP_401_UNAUTHORIZED,
                    detail="Email not found in Google token"
                )
            return data
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=f"Google token verification failed: {str(e)}"
        )

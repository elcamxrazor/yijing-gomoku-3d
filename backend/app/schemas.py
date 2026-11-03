from pydantic import BaseModel, Field


class Credentials(BaseModel):
    username: str = Field(min_length=3, max_length=24)
    password: str = Field(min_length=8, max_length=128)


def user_dict(user) -> dict:
    # Public protocol uses string ids so browser clients can treat all player
    # ids (including the "yixin" bot) uniformly.
    return {"id": str(user.id), "name": user.name, "guest": user.guest}

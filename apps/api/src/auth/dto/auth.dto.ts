import {
  IsEmail,
  IsString,
  MinLength,
  MaxLength,
  Matches,
} from "class-validator";

export class SignupDto {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(8)
  @MaxLength(128)
  @Matches(/[a-zA-Z]/, {
    message: "password must contain at least one letter",
  })
  @Matches(/[0-9]/, {
    message: "password must contain at least one number",
  })
  password!: string;

  @IsString()
  @MinLength(2)
  @MaxLength(100)
  displayName!: string;
}

export class SigninDto {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(1)
  password!: string;
}

export class VerifyEmailDto {
  @IsString()
  token!: string;
}

export class ResendVerificationDto {
  @IsEmail()
  email!: string;
}

export class ForgotPasswordDto {
  @IsEmail()
  email!: string;
}

export class ResetPasswordDto {
  @IsString()
  token!: string;

  @IsString()
  @MinLength(8)
  @MaxLength(128)
  @Matches(/[a-zA-Z]/, {
    message: "password must contain at least one letter",
  })
  @Matches(/[0-9]/, {
    message: "password must contain at least one number",
  })
  password!: string;
}

export class ChangePasswordDto {
  @IsString()
  @MinLength(1)
  currentPassword!: string;

  @IsString()
  @MinLength(8)
  @MaxLength(128)
  @Matches(/[a-zA-Z]/, {
    message: "password must contain at least one letter",
  })
  @Matches(/[0-9]/, {
    message: "password must contain at least one number",
  })
  newPassword!: string;
}

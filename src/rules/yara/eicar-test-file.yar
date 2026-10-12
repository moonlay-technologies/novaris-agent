rule eicar_test_file
{
    meta:
        description = "Detects the EICAR standard antivirus test file - a public-domain string designed for verifying scanner pipelines work end to end. Not real malware."
        reference = "https://www.eicar.org/download-anti-malware-testfile/"
        author = "Novaris"

    strings:
        $eicar = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*"

    condition:
        $eicar
}

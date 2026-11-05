// SPDX-License-Identifier: GPL-3.0
/*
    Copyright 2021 0KIMS association.

    This file is generated with [snarkJS](https://github.com/iden3/snarkjs).

    snarkJS is a free software: you can redistribute it and/or modify it
    under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    snarkJS is distributed in the hope that it will be useful, but WITHOUT
    ANY WARRANTY; without even the implied warranty of MERCHANTABILITY
    or FITNESS FOR A PARTICULAR PURPOSE. See the GNU General Public
    License for more details.

    You should have received a copy of the GNU General Public License
    along with snarkJS. If not, see <https://www.gnu.org/licenses/>.
*/

pragma solidity ^0.8.20;

contract SpendVerifier {
    // Scalar field size
    uint256 constant r    = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
    // Base field size
    uint256 constant q   = 21888242871839275222246405745257275088696311157297823662689037894645226208583;

    // Verification Key data
    uint256 constant alphax  = 18507475543336944384208989784753468703000929752919926323246522892316197150004;
    uint256 constant alphay  = 11767985856728659429858778422509441429862102699063823780688670845675770561771;
    uint256 constant betax1  = 15931673081882038693971546905756404466154719039779301798885281025874931067165;
    uint256 constant betax2  = 15725534130079164411862781677797251893159893603733902884277919293633396703325;
    uint256 constant betay1  = 9646905524345157781305737068632425607347662468547048319467749958188633268910;
    uint256 constant betay2  = 14840284232176824693385760320978291500613912430600322842851787869410499738512;
    uint256 constant gammax1 = 11559732032986387107991004021392285783925812861821192530917403151452391805634;
    uint256 constant gammax2 = 10857046999023057135944570762232829481370756359578518086990519993285655852781;
    uint256 constant gammay1 = 4082367875863433681332203403145435568316851327593401208105741076214120093531;
    uint256 constant gammay2 = 8495653923123431417604973247489272438418190587263600148770280649306958101930;
    uint256 constant deltax1 = 9153184149659610236147693179830208677250220957092611601532086440542045059478;
    uint256 constant deltax2 = 15932999324802735729431985661325749765527869204894645321763218635850694931944;
    uint256 constant deltay1 = 18403566709616714661243621481834649349529117173844673198405116754594293196301;
    uint256 constant deltay2 = 5993855750306634704922899852309120310984768087372610351083210617728367789055;

    
    uint256 constant IC0x = 2578541489653182320777390649415229055284407245550166641105895191744147857243;
    uint256 constant IC0y = 16025432838012173590755010744647488356989729536005997117954490652062696068178;
    
    uint256 constant IC1x = 18550736423936376399061735889165990404618463554533561742164305114546777627661;
    uint256 constant IC1y = 1673148426341339343808858264057924939125096088983183728123531081717487762951;
    
    uint256 constant IC2x = 2333145534993204662338875078579243695876966266977431109561247182172246257049;
    uint256 constant IC2y = 15467695958709924790133120082338592575126700730167034948062312692356756258339;
    
    uint256 constant IC3x = 10232965507013599701075480197695539997980185600964904943689794640362318811755;
    uint256 constant IC3y = 5521983208054336771285559965656964895030350394287045384931415918060286832618;
    
    uint256 constant IC4x = 3167571903819116637911045497915457545200793026826502826651905837470960369257;
    uint256 constant IC4y = 20733299342611889659248622022961568106625895072139173170338021071028336987340;
    
    uint256 constant IC5x = 17442573345838931723417656161053831901651125191163810226066005784304542416236;
    uint256 constant IC5y = 900356955095804314508505417125267919773892081953947405744799044479158908277;
    
    uint256 constant IC6x = 948751059377070563434208659152745942888222115050850526400504723063921509445;
    uint256 constant IC6y = 8023803498768019018016922956625826948248477822759735158943995772056873739529;
    
    uint256 constant IC7x = 8495760322540077727805289421539238580526428818653026284443229146871363806674;
    uint256 constant IC7y = 17040744890902201295422492665877526236080704005636048413721711252998149933785;
    
    uint256 constant IC8x = 13573308213920195695621489709809920700221386633474253788672848621393986134271;
    uint256 constant IC8y = 21616716858339383941135529647928654044481763013470249130922723209527948529880;
    
    uint256 constant IC9x = 13193932617178219454380396861274047688456972091758852240233047095262276128929;
    uint256 constant IC9y = 4060671737466562917817878288817662803058049617100649743206553633400557889493;
    
    uint256 constant IC10x = 681944123377143124754845726930074573207791314636630402198114064024819267797;
    uint256 constant IC10y = 808553392997155790607637545102761581115301504563838478397474631717036397793;
    
    uint256 constant IC11x = 17270115006270579814871343577947891221539226473819848929552123813611316635603;
    uint256 constant IC11y = 11087917475229079507309146362573693672204175902116517754463876599741318491681;
    
    uint256 constant IC12x = 10661852900182895124194820660932928278912194302901491683615099531059918877620;
    uint256 constant IC12y = 20798523043739411239284957247751636630055725665021116721772926676465631720543;
    
    uint256 constant IC13x = 17162982087512022637815838093423486928505485136018406381431745664758687027369;
    uint256 constant IC13y = 20350443451163940921227747756180818208946826483616796656813317970856432536645;
    
    uint256 constant IC14x = 440939590200636261478802001821644082271427969378289861892756128922506408293;
    uint256 constant IC14y = 19766527151749831984455516258051165988224284777454003818982904617018188574041;
    
    uint256 constant IC15x = 21531473083529362282545616813218618247802063197704423712111852456381162276911;
    uint256 constant IC15y = 5555683341299145017882668236692689091796011321478800667986451182622501733976;
    
 
    // Memory data
    uint16 constant pVk = 0;
    uint16 constant pPairing = 128;

    uint16 constant pLastMem = 896;

    function verifyProof(uint[2] calldata _pA, uint[2][2] calldata _pB, uint[2] calldata _pC, uint[15] calldata _pubSignals) public view returns (bool) {
        assembly {
            function checkField(v) {
                if iszero(lt(v, r)) {
                    mstore(0, 0)
                    return(0, 0x20)
                }
            }
            
            // G1 function to multiply a G1 value(x,y) to value in an address
            function g1_mulAccC(pR, x, y, s) {
                let success
                let mIn := mload(0x40)
                mstore(mIn, x)
                mstore(add(mIn, 32), y)
                mstore(add(mIn, 64), s)

                success := staticcall(sub(gas(), 2000), 7, mIn, 96, mIn, 64)

                if iszero(success) {
                    mstore(0, 0)
                    return(0, 0x20)
                }

                mstore(add(mIn, 64), mload(pR))
                mstore(add(mIn, 96), mload(add(pR, 32)))

                success := staticcall(sub(gas(), 2000), 6, mIn, 128, pR, 64)

                if iszero(success) {
                    mstore(0, 0)
                    return(0, 0x20)
                }
            }

            function checkPairing(pA, pB, pC, pubSignals, pMem) -> isOk {
                let _pPairing := add(pMem, pPairing)
                let _pVk := add(pMem, pVk)

                mstore(_pVk, IC0x)
                mstore(add(_pVk, 32), IC0y)

                // Compute the linear combination vk_x
                
                g1_mulAccC(_pVk, IC1x, IC1y, calldataload(add(pubSignals, 0)))
                
                g1_mulAccC(_pVk, IC2x, IC2y, calldataload(add(pubSignals, 32)))
                
                g1_mulAccC(_pVk, IC3x, IC3y, calldataload(add(pubSignals, 64)))
                
                g1_mulAccC(_pVk, IC4x, IC4y, calldataload(add(pubSignals, 96)))
                
                g1_mulAccC(_pVk, IC5x, IC5y, calldataload(add(pubSignals, 128)))
                
                g1_mulAccC(_pVk, IC6x, IC6y, calldataload(add(pubSignals, 160)))
                
                g1_mulAccC(_pVk, IC7x, IC7y, calldataload(add(pubSignals, 192)))
                
                g1_mulAccC(_pVk, IC8x, IC8y, calldataload(add(pubSignals, 224)))
                
                g1_mulAccC(_pVk, IC9x, IC9y, calldataload(add(pubSignals, 256)))
                
                g1_mulAccC(_pVk, IC10x, IC10y, calldataload(add(pubSignals, 288)))
                
                g1_mulAccC(_pVk, IC11x, IC11y, calldataload(add(pubSignals, 320)))
                
                g1_mulAccC(_pVk, IC12x, IC12y, calldataload(add(pubSignals, 352)))
                
                g1_mulAccC(_pVk, IC13x, IC13y, calldataload(add(pubSignals, 384)))
                
                g1_mulAccC(_pVk, IC14x, IC14y, calldataload(add(pubSignals, 416)))
                
                g1_mulAccC(_pVk, IC15x, IC15y, calldataload(add(pubSignals, 448)))
                

                // -A
                mstore(_pPairing, calldataload(pA))
                mstore(add(_pPairing, 32), mod(sub(q, calldataload(add(pA, 32))), q))

                // B
                mstore(add(_pPairing, 64), calldataload(pB))
                mstore(add(_pPairing, 96), calldataload(add(pB, 32)))
                mstore(add(_pPairing, 128), calldataload(add(pB, 64)))
                mstore(add(_pPairing, 160), calldataload(add(pB, 96)))

                // alpha1
                mstore(add(_pPairing, 192), alphax)
                mstore(add(_pPairing, 224), alphay)

                // beta2
                mstore(add(_pPairing, 256), betax1)
                mstore(add(_pPairing, 288), betax2)
                mstore(add(_pPairing, 320), betay1)
                mstore(add(_pPairing, 352), betay2)

                // vk_x
                mstore(add(_pPairing, 384), mload(add(pMem, pVk)))
                mstore(add(_pPairing, 416), mload(add(pMem, add(pVk, 32))))


                // gamma2
                mstore(add(_pPairing, 448), gammax1)
                mstore(add(_pPairing, 480), gammax2)
                mstore(add(_pPairing, 512), gammay1)
                mstore(add(_pPairing, 544), gammay2)

                // C
                mstore(add(_pPairing, 576), calldataload(pC))
                mstore(add(_pPairing, 608), calldataload(add(pC, 32)))

                // delta2
                mstore(add(_pPairing, 640), deltax1)
                mstore(add(_pPairing, 672), deltax2)
                mstore(add(_pPairing, 704), deltay1)
                mstore(add(_pPairing, 736), deltay2)


                let success := staticcall(sub(gas(), 2000), 8, _pPairing, 768, _pPairing, 0x20)

                isOk := and(success, mload(_pPairing))
            }

            let pMem := mload(0x40)
            mstore(0x40, add(pMem, pLastMem))

            // Validate that all evaluations ∈ F
            
            checkField(calldataload(add(_pubSignals, 0)))
            
            checkField(calldataload(add(_pubSignals, 32)))
            
            checkField(calldataload(add(_pubSignals, 64)))
            
            checkField(calldataload(add(_pubSignals, 96)))
            
            checkField(calldataload(add(_pubSignals, 128)))
            
            checkField(calldataload(add(_pubSignals, 160)))
            
            checkField(calldataload(add(_pubSignals, 192)))
            
            checkField(calldataload(add(_pubSignals, 224)))
            
            checkField(calldataload(add(_pubSignals, 256)))
            
            checkField(calldataload(add(_pubSignals, 288)))
            
            checkField(calldataload(add(_pubSignals, 320)))
            
            checkField(calldataload(add(_pubSignals, 352)))
            
            checkField(calldataload(add(_pubSignals, 384)))
            
            checkField(calldataload(add(_pubSignals, 416)))
            
            checkField(calldataload(add(_pubSignals, 448)))
            

            // Validate all evaluations
            let isValid := checkPairing(_pA, _pB, _pC, _pubSignals, pMem)

            mstore(0, isValid)
             return(0, 0x20)
         }
     }
 }
